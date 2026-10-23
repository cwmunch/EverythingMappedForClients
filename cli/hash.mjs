import crypto from 'node:crypto';
import fs from 'node:fs';

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}
