import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson, stateDir, samePath } from './paths.js';
import { powerErrorDetails } from './power-error.js';

export const policyFile = home => path.join(stateDir(home), 'power-policy.json');

function load(home) {
  const ledger = readJson(policyFile(home), { schema: 1, product: 'keepawake', home, schemes: {} });
  if (ledger.schema !== 1 || ledger.product !== 'keepawake' || !samePath(ledger.home, home) || !ledger.schemes || typeof ledger.schemes !== 'object' || Array.isArray(ledger.schemes)) throw new Error('The power settings backup is invalid.');
  for (const [scheme, values] of Object.entries(ledger.schemes)) {
    if (!/^[0-9a-f-]{36}$/i.test(scheme) || !values || typeof values !== 'object' || Object.keys(values).some(mode => !['ac', 'dc'].includes(mode)) || Object.values(values).some(value => !Number.isInteger(value) || value < 0 || value > 3)) throw new Error('The lid settings backup contains invalid values.');
  }
  ledger.pendingRefresh ??= [];
  if (!Array.isArray(ledger.pendingRefresh) || ledger.pendingRefresh.some(scheme => !/^[0-9a-f-]{36}$/i.test(scheme))) throw new Error('The pending power settings backup is invalid.');
  return ledger;
}

function save(home, ledger) {
  if (Object.keys(ledger.schemes).length || ledger.pendingRefresh.length) writeJson(policyFile(home), ledger);
  else fs.rmSync(policyFile(home), { force: true });
}

function pending(ledger, scheme, enabled) {
  ledger.pendingRefresh = ledger.pendingRefresh.filter(item => item !== scheme);
  if (enabled) ledger.pendingRefresh.push(scheme);
}

export function lidStatus(native) {
  const scheme = native.active();
  return { scheme, ac: native.read(scheme, 'ac'), dc: native.read(scheme, 'dc') };
}

export function inspectLid(native) {
  try {
    const status = lidStatus(native);
    const access = native.access?.() || { ac: null, dc: null, activeScheme: null };
    return { ...status, checkedAt: new Date().toISOString(), backend: native.backend || 'native', access,
      configured: status.ac === 0 && status.dc === 0 && access.ac === 0 && access.dc === 0,
      policyBlocked: Object.values(access).includes(1260),
      actions: { ac: ['do-nothing', 'sleep', 'hibernate', 'shutdown'][status.ac] || 'unknown', dc: ['do-nothing', 'sleep', 'hibernate', 'shutdown'][status.dc] || 'unknown' }, error: null };
  } catch (error) {
    return { checkedAt: new Date().toISOString(), backend: native.backend || 'native', configured: false,
      policyBlocked: error.code === 1260, error: powerErrorDetails(error) };
  }
}

export function enableLid(home, native) {
  const ledger = load(home), scheme = native.active();
  const previous = { ac: native.read(scheme, 'ac'), dc: native.read(scheme, 'dc') };
  if (!ledger.schemes[scheme]) ledger.schemes[scheme] = {};
  const saved = ledger.schemes[scheme];
  const attempted = [];
  const previouslyPending = ledger.pendingRefresh.includes(scheme);
  try {
    for (const mode of ['ac', 'dc']) {
      if (previous[mode] === 0) continue;
      // If the user changed a previously configured plan, remember that newer
      // choice before an explicit second enable, rather than an obsolete one.
      saved[mode] = previous[mode];
      pending(ledger, scheme, true);
      save(home, ledger); // Durable backup and apply marker before every write.
      attempted.push(mode);
      native.write(scheme, mode, 0);
    }
    // Reapplying an unchanged scheme can fail under a managed active-plan
    // policy, even though no setting needs to be changed.
    if (ledger.pendingRefresh.includes(scheme)) {
      native.refresh(scheme);
      pending(ledger, scheme, false);
    }
    const verified = lidStatus(native);
    if (verified.ac !== 0 || verified.dc !== 0) throw new Error('Lid configuration verification failed: the current plan does not report Do Nothing for both power sources.');
  } catch (error) {
    let restored = false, rollbackFailed = false;
    // Only undo writes attempted by this operation; another mode may have
    // changed independently while the first write was being rejected.
    for (const mode of attempted.reverse()) {
      try {
        if (native.read(scheme, mode) === 0) {
          native.write(scheme, mode, previous[mode]);
          restored = true;
        }
        delete saved[mode];
      } catch {
        rollbackFailed = true;
      }
    }
    if (restored) {
      try { native.refresh(scheme); }
      catch { rollbackFailed = true; }
    }
    if (!Object.keys(saved).length) delete ledger.schemes[scheme];
    pending(ledger, scheme, previouslyPending || rollbackFailed);
    save(home, ledger);
    throw error;
  }
  if (!Object.keys(saved).length) delete ledger.schemes[scheme];
  save(home, ledger);
  return lidStatus(native);
}

export function restoreLid(home, native) {
  const ledger = load(home), errors = [];
  for (const scheme of new Set([...Object.keys(ledger.schemes), ...ledger.pendingRefresh])) {
    const saved = ledger.schemes[scheme] || {};
    const resolved = [];
    for (const [mode, before] of Object.entries(saved)) {
      try {
        // A later manual change belongs to the user and must survive uninstall.
        if (native.read(scheme, mode) === 0) {
          pending(ledger, scheme, true);
          save(home, ledger);
          native.write(scheme, mode, before);
        }
        resolved.push(mode);
      } catch (error) {
        if (error.code === 2) resolved.push(mode);
        else errors.push(error);
      }
    }
    let refreshed = false;
    try {
      if (ledger.pendingRefresh.includes(scheme)) native.refresh(scheme);
      pending(ledger, scheme, false);
      refreshed = true;
    }
    catch (error) { if (error.code === 2) { pending(ledger, scheme, false); refreshed = true; } else errors.push(error); }
    if (refreshed) {
      for (const mode of resolved) delete saved[mode];
    }
    if (!Object.keys(saved).length) delete ledger.schemes[scheme];
  }
  save(home, ledger);
  if (errors.length) throw new AggregateError(errors, `Could not restore all lid settings: ${errors[0].message}`);
}
