import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { enableLid, restoreLid, policyFile, lidStatus, inspectLid } from '../src/power-policy.js';
import { readJson } from '../src/paths.js';
import { createPowerPolicyNative } from '../src/power-native.js';
import { temporary, removeTemporary } from './helpers.js';
import { createPowercfgWriter } from '../src/powercfg.js';
import { powerError } from '../src/power-error.js';
import { buildDiagnostics } from '../src/diagnostics.js';

const scheme = '381b4222-f694-41f0-9685-ff5bb260df2e';
function fake(home, initial = { ac: 1, dc: 2 }) {
  return {
    values: { ...initial }, writes: [], failure: null, refresh() {}, active: () => scheme,
    read(_scheme, mode) { return this.values[mode]; },
    write(_scheme, mode, value) {
      if (value === 0 && this.values[mode] !== 0) assert.equal(readJson(policyFile(home)).schemes[scheme][mode], this.values[mode], 'backup must precede mutation');
      if (this.failure?.(mode, value)) throw new Error('Simulated policy failure');
      this.values[mode] = value; this.writes.push({ mode, value });
    }
  };
}

test('lid configuration is journaled, idempotent and restores exact previous values', () => {
  const home = temporary(), native = fake(home);
  try {
    assert.deepEqual(enableLid(home, native), { scheme, ac: 0, dc: 0 });
    enableLid(home, native); assert.equal(native.writes.length, 2);
    restoreLid(home, native); assert.deepEqual(native.values, { ac: 1, dc: 2 });
    assert.equal(fs.existsSync(policyFile(home)), false);
    restoreLid(home, native); assert.equal(native.writes.length, 4);
  } finally { removeTemporary(home); }
});

test('uninstall preserves later user changes and never fabricates default values', () => {
  const home = temporary(), native = fake(home, { ac: 0, dc: 1 });
  try {
    enableLid(home, native); native.values.dc = 3;
    restoreLid(home, native); assert.deepEqual(native.values, { ac: 0, dc: 3 });
    assert.deepEqual(native.writes, [{ mode: 'dc', value: 0 }]);
  } finally { removeTemporary(home); }
});

test('a failed second write rolls back the first and leaves no stale backup', () => {
  const home = temporary(), native = fake(home);
  try {
    native.failure = (mode, value) => mode === 'dc' && value === 0;
    assert.throws(() => enableLid(home, native), /Simulated/);
    assert.deepEqual(native.values, { ac: 1, dc: 2 });
    assert.equal(fs.existsSync(policyFile(home)), false);
    restoreLid(home, native);
    assert.equal(fs.existsSync(policyFile(home)), false);
  } finally { removeTemporary(home); }
});

test('a failed rollback preserves the recoverable journal for the un-restored setting', () => {
  const home = temporary(), native = fake(home);
  try {
    native.failure = (mode, value) => (mode === 'dc' && value === 0) || (mode === 'ac' && value === 1);
    assert.throws(() => enableLid(home, native), /Simulated/);
    assert.deepEqual(native.values, { ac: 0, dc: 2 });
    assert.ok(fs.existsSync(policyFile(home)));
    assert.deepEqual(readJson(policyFile(home)).schemes[scheme], { ac: 1 });
    assert.deepEqual(readJson(policyFile(home)).pendingRefresh, [scheme]);
    native.failure = null;
    restoreLid(home, native);
    assert.deepEqual(native.values, { ac: 1, dc: 2 });
    assert.equal(fs.existsSync(policyFile(home)), false);
  } finally { removeTemporary(home); }
});

test('failed restoration keeps the remaining backup for retry', () => {
  const home = temporary(), native = fake(home);
  try {
    enableLid(home, native); native.failure = mode => mode === 'dc';
    assert.throws(() => restoreLid(home, native));
    assert.deepEqual(native.values, { ac: 1, dc: 0 });
    assert.deepEqual(readJson(policyFile(home)).schemes[scheme], { dc: 2 });
    native.failure = null; restoreLid(home, native);
    assert.deepEqual(native.values, { ac: 1, dc: 2 });
  } finally { removeTemporary(home); }
});

test('native power-policy probe only reads the real machine', () => {
  const status = lidStatus(createPowerPolicyNative());
  assert.match(status.scheme, /^[a-f0-9-]{36}$/);
  assert.ok(status.ac >= 0 && status.ac <= 3); assert.ok(status.dc >= 0 && status.dc <= 3);
});

test('the legacy powercfg method uses the correct lid GUID and identifies a policy failure', () => {
  const calls = [];
  const writer = createPowercfgWriter({ execute(file, args, options) { calls.push({ file, args, options }); } });
  writer.write(scheme, 'ac', 0); writer.write(scheme, 'dc', 2); writer.refresh(scheme);
  assert.match(calls[0].file, /System32[\\/]powercfg\.exe$/i);
  assert.deepEqual(calls.map(call => call.args), [
    ['/setacvalueindex', scheme, '4f971e89-eebd-4455-a8de-9e59040e7347', '5ca83367-6e45-459f-a27b-476b1d01c936', '0'],
    ['/setdcvalueindex', scheme, '4f971e89-eebd-4455-a8de-9e59040e7347', '5ca83367-6e45-459f-a27b-476b1d01c936', '2'], ['/setactive', scheme]
  ]);
  assert.ok(calls.every(call => call.options.windowsHide && !call.options.shell && call.options.timeout === 10000));
  assert.throws(() => writer.write('bad scheme', 'ac', 0));
  assert.throws(() => writer.write(scheme, 'invalid', 0));
  assert.throws(() => writer.write(scheme, 'ac', 4));
  const denied = createPowercfgWriter({ execute() { throw Object.assign(new Error('denied'), { status: 1260, stderr: 'Policy restriction' }); } });
  assert.throws(() => denied.write(scheme, 'ac', 0), error => error.code === 1260 && error.operation === 'Write AC lid action' && error.backend === 'powercfg' && /Group Policy/.test(error.message));
  const override = createPowercfgWriter({ execute() { throw Object.assign(new Error('override'), { status: 1, stderr: 'Group policy override settings exist for this power scheme or power setting.' }); } });
  assert.throws(() => override.write(scheme, 'dc', 0), error => error.code === 1260 && error.operation === 'Write DC lid action' && error.backend === 'powercfg' && /Group Policy/.test(error.message));
  const activation = createPowercfgWriter({ execute() { throw Object.assign(new Error('denied'), { status: 1260 }); } });
  assert.throws(() => activation.refresh(scheme), error => error.operation === 'Apply active power scheme');
  assert.match(powerError(5, 'Write AC lid action').message, /Access denied/);
  assert.doesNotMatch(powerError(1260, 'Write AC lid action').message, /Run.*as administrator/);
});

test('an unchanged lid plan is not reactivated under an active-scheme restriction', () => {
  const home = temporary(), native = fake(home, { ac: 0, dc: 0 });
  try {
    native.refresh = () => { throw powerError(1260, 'Apply active power scheme'); };
    assert.deepEqual(enableLid(home, native), { scheme, ac: 0, dc: 0 });
    assert.equal(native.writes.length, 0);
    assert.equal(fs.existsSync(policyFile(home)), false);
  } finally { removeTemporary(home); }
});

test('a rejected first write leaves no pending activation, no stale backup and can be uninstalled without reapplying a managed plan', () => {
  const home = temporary(), native = fake(home);
  try {
    native.failure = () => { throw powerError(1260, 'Write AC lid action'); };
    native.refresh = () => { throw new Error('An unchanged plan must not be reapplied'); };
    assert.throws(() => enableLid(home, native), error => error.code === 1260);
    assert.deepEqual(native.values, { ac: 1, dc: 2 });
    assert.equal(fs.existsSync(policyFile(home)), false);
    restoreLid(home, native);
    assert.equal(fs.existsSync(policyFile(home)), false);
  } finally { removeTemporary(home); }
});

test('a failed restoration apply is retried even after registry values have been restored', () => {
  const home = temporary(), native = fake(home);
  try {
    enableLid(home, native);
    native.refresh = () => { throw powerError(1260, 'Apply active power scheme'); };
    assert.throws(() => restoreLid(home, native));
    assert.deepEqual(native.values, { ac: 1, dc: 2 });
    assert.deepEqual(readJson(policyFile(home)).pendingRefresh, [scheme]);
    let reapplied = false;
    native.refresh = () => { reapplied = true; };
    restoreLid(home, native);
    assert.equal(reapplied, true); assert.equal(fs.existsSync(policyFile(home)), false);
  } finally { removeTemporary(home); }
});

test('diagnostics expose the reported corporate lid restriction without altering settings or including identity secrets', () => {
  const home = temporary(), native = fake(home, { ac: 1, dc: 1 });
  try {
    native.access = () => ({ ac: 1260, dc: 1260, activeScheme: 0 });
    const lid = inspectLid(native);
    assert.equal(lid.configured, false); assert.equal(lid.policyBlocked, true);
    assert.deepEqual(lid.actions, { ac: 'sleep', dc: 'sleep' });
    const report = buildDiagnostics(home, { active: true, version: '1.0.0', home: 'private-home', token: 'private-token', instance: 'private-instance',
      config: { activity: true, display: true, interval: 55 }, pulses: 6, idleSeconds: 0, elevated: false }, native);
    assert.equal(report.application.active, true); assert.equal(report.lid.configured, false);
    assert.ok(report.warnings.some(warning => warning.includes('1260')));
    assert.doesNotMatch(JSON.stringify(report), /private-home|private-token|private-instance/);
    assert.equal(native.writes.length, 0);
  } finally { removeTemporary(home); }
});
