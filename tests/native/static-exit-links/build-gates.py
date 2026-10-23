from pathlib import Path
from test_support import ROOT, SOURCE, COMPILER, NATIVE_FLAGS
import hashlib
import json
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
utilities = runpy.run_path(str(OWN / 'build-helpers.py'))
candidate, function = utilities['candidate'], utilities['function']
source = (OWN / 'helpers.cpp').read_text(encoding='utf8').replace('int main()\n', 'int HelperFixtureMain()\n')
# gate.template.cpp defines the counting DolphinWebHelperDisabled the gate cases assert on.
source = source.replace('bool DolphinWebHelperDisabled(u32) { return false; }  // CACHE_HELPER_STUB\n', 'bool DolphinWebHelperDisabled(u32);\n')
assert 'CACHE_HELPER_STUB' not in source
machine = '''namespace CPU { enum class State { Running, Stepping, PowerDown }; }
struct Machine {
  struct CPUState { CPU::State state = CPU::State::Running; const CPU::State* pointer = &state;
    const CPU::State* GetStatePtr() { return pointer; } } cpu;
  struct Timing { unsigned advances = 0; void Advance() { ++advances; } } timing;
  CPUState& GetCPU() { return cpu; } Timing& GetCoreTiming() { return timing; }
};
'''
source = source.replace('struct JitBlock\n', machine + '\nstruct JitBlock\n', 1)
source = source.replace('  void Clear();\n', '''  void Clear();
  std::function<const u8*()> dispatch_for_test;
  unsigned dispatch_calls = 0;
  const u8* Dispatch() { ++dispatch_calls; return dispatch_for_test(); }
''', 1)
source = source.replace('  bool debug = false,', '''  PowerPC::PowerPCState m_ppc_state;
  Machine m_system;
  unsigned jit_calls = 0; u32 jit_pc = 0;
  const L::Context* expected_context_at_jit = nullptr;
  bool native_direct_wasm = false;
  void Jit(u32 pc) { require(L::active_context == expected_context_at_jit, "source context must close before miss compilation"); ++jit_calls; jit_pc = pc; }
  void ExecuteOneBlock(bool allow_redispatch = true); void SingleStep();
  bool debug = false,''', 1)
source = source.replace('void UpdatePerformanceMonitorIfNeeded(', 'std::function<void()> perf_callback;\nvoid UpdatePerformanceMonitorIfNeeded(', 1)
source = source.replace('std::to_string(fp)); }', 'std::to_string(fp)); if (perf_callback) perf_callback(); }', 1)
execute = function(candidate, 'void CachedInterpreter::ExecuteOneBlock(')
begin = execute.index('  while (true)\n  {')
end = execute.index('\n#ifdef __EMSCRIPTEN__\n    if (redispatch_enabled', begin)
kernel = '''  while (true)
  {
    const auto callback = *reinterpret_cast<const AnyCallback*>(normal_entry);
    const u8* payload = normal_entry + sizeof(callback);
    // Host fixture ABI adapter: the generic callback arm and the existing
    // direct-WASM arm execute real callbacks; unrelated optimized fast arms
    // are omitted. The outer source context/redispatch implementation is exact.
    const auto distance = native_direct_wasm && callback == AnyCallbackCast(RunWasmBlock) ?
        RunWasmBlock(ppc_state, *reinterpret_cast<const WasmBlockOperands*>(payload)) :
        callback(ppc_state, payload);
    if (distance) normal_entry += distance;
    else break;
  }'''
execute = execute[:begin] + kernel + execute[end:]
step = function(candidate, 'void CachedInterpreter::SingleStep()')
extra = (OWN / 'gate.template.cpp').read_text(encoding='utf8')
extra = extra.replace('/* EXECUTION */', execute + '\n' + step)
cpp = OWN / 'gates.cpp'; cpp.write_text(source + '\n' + extra, encoding='utf8')
inputs = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [SOURCE / 'CachedInterpreter.cpp', SOURCE / 'CachedInterpreterLink.h']}
build = subprocess.run([COMPILER, '-std=c++20', '-O2', *NATIVE_FLAGS, '-Wall', '-Wextra',
    '-DDOLPHIN_WEB_STATIC_EXIT_LINKS=1', str(cpp), '-o', str(OWN / 'gates.exe')], capture_output=True, text=True, timeout=60)
(OWN / 'gates-build.log').write_text(build.stdout + build.stderr, encoding='utf8')
if build.returncode: print(build.stdout + build.stderr)
build.check_returncode()
run = subprocess.run([str(OWN / 'gates.exe')], capture_output=True, text=True, timeout=30)
(OWN / 'gates-run.log').write_text(run.stdout + run.stderr, encoding='utf8')
report = {'inputs': inputs, 'exitCode': run.returncode,
          'results': json.loads(run.stdout) if run.stdout.startswith('{') else run.stdout,
          'scope': 'Actual candidate ExecuteOneBlock outer loop/context/redispatch and SingleStep. Source-backed callbacks, emitted records and base linker/lookup are used.',
          'adapters': ['Inner optimized callback-dispatch chain reduced to generic callback plus selectable typed direct-WASM call; both execute actual callback methods.',
                       'Dispatch records lookup calls and returns actual GetBlockFromStartAddress matches; compiler miss is a recording stub that asserts source scope already closed.',
                       'Native CPU/timing/profiler adapters record gate calls; protected native state pages verify short-circuit avoidance.']}
report['inputsUnchanged'] = all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == sha for path, sha in inputs.items())
(OWN / 'gates-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report, indent=2)); assert report['inputsUnchanged']; run.check_returncode()
