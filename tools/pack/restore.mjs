#!/usr/bin/env node
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const backupPath = join(process.cwd(), 'package.json.pack-backup');
if (!existsSync(backupPath)) process.exit(0);
renameSync(backupPath, join(process.cwd(), 'package.json'));
