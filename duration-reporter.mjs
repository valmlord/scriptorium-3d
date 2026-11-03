import os from 'node:os';

export default class DurationReporter {
  tests = [];
  modules = [];

  onTestCaseResult(testCase) {
    this.tests.push({
      name: testCase.fullName ?? testCase.name,
      file: testCase.module?.moduleId ?? '?',
      ms: testCase.diagnostic?.()?.duration ?? 0,
    });
  }

  onTestModuleEnd(testModule) {
    const d = testModule.diagnostic?.() ?? {};
    this.modules.push({
      file: testModule.moduleId ?? '?',
      ms: d.duration ?? 0,
      collect: d.collectDuration ?? 0,
      setup: d.setupDuration ?? 0,
      prepare: d.prepareDuration ?? 0,
    });
  }

  onTestRunEnd() {
    const cwd = process.cwd() + '/';
    const cpus = os.cpus();
    const short = (f) => f.replace(cwd, '');
    console.log('');
    console.log('### machine');
    console.log(
      `${cpus[0]?.model} x ${cpus.length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB, Node ${process.version}, ${os.platform()}/${os.arch()}`
    );
    console.log('');
    console.log(`### ${this.tests.length} tests, slowest 20`);
    for (const t of [...this.tests].sort((a, b) => b.ms - a.ms).slice(0, 20)) {
      console.log(`${t.ms.toFixed(0).padStart(7)} ms  ${short(t.file)} > ${t.name}`);
    }
    console.log('');
    console.log(
      `### ${this.modules.length} modules: total / collect / setup / prepare / residual (hooks+teardown)`
    );
    for (const m of [...this.modules].sort((a, b) => b.ms - a.ms)) {
      const inTests = this.tests
        .filter((t) => t.file === m.file)
        .reduce((sum, t) => sum + t.ms, 0);
      console.log(
        `${m.ms.toFixed(0).padStart(7)} / ${m.collect.toFixed(0).padStart(5)} / ${m.setup.toFixed(0).padStart(5)} / ${m.prepare.toFixed(0).padStart(5)} / ${(m.ms - inTests).toFixed(0).padStart(6)} ms  ${short(m.file)}`
      );
    }
    console.log('');
  }
}
