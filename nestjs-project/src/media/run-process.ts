import { spawn } from 'node:child_process';
import {
  MediaProcessFailedError,
  MediaProcessTimeoutError,
} from './media.errors';

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

// Runs a binary without a shell (arguments are never interpolated) and kills it
// when it exceeds the timeout.
export function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new MediaProcessTimeoutError(command, timeoutMs));
      } else if (code !== 0) {
        reject(new MediaProcessFailedError(command, code, stderr));
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      }
    });
  });
}
