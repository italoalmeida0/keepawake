import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { powerError } from './power-error.js';

const subgroup = '4f971e89-eebd-4455-a8de-9e59040e7347';
const lid = '5ca83367-6e45-459f-a27b-476b1d01c936';
const validScheme = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createPowercfgWriter({ execute = execFileSync } = {}) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'powercfg.exe');
  function run(args, operation) {
    try {
      execute(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (!Number.isInteger(error.status)) throw new Error(`${operation} could not run: ${error.message}`);
      const output = `${error.stderr || ''}\n${error.stdout || ''}`;
      const code = (/group policy override/i.test(output) || error.status === 1260) ? 1260 : error.status;
      throw powerError(code, operation, 'powercfg', output);
    }
  }
  return {
    write(scheme, mode, value) {
      if (!validScheme(scheme) || !['ac', 'dc'].includes(mode) || !Number.isInteger(value) || value < 0 || value > 3) throw new Error('Invalid lid configuration request.');
      run([mode === 'ac' ? '/setacvalueindex' : '/setdcvalueindex', scheme, subgroup, lid, String(value)], `Write ${mode.toUpperCase()} lid action`);
    },
    refresh(scheme) {
      if (!validScheme(scheme)) throw new Error('Invalid power scheme GUID.');
      run(['/setactive', scheme], 'Apply active power scheme');
    }
  };
}
