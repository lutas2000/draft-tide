// The app binary's entry. guard.ts runs first in every mode (it refuses
// debugging switches). Then either the GUI app, or, when the Engine started
// this binary with --dt-preview-host, the isolated Preview Host: it renders
// what the Engine sends over its pipe and never opens a window, the Engine
// channel or anything of the GUI's.
//
// A release ships the Preview Host as its own executable (packagedLayout's
// previewHost, a copy of this one signed under another identifier), so the
// executable decides: the app's own never renders a page, whatever its
// arguments, and the Preview Host's never runs the GUI. A page that escaped
// the renderer's sandbox then runs as code the Engine's desktop check
// rejects. Only the app's own executable carries the desktop identity: a
// renamed copy of it doesn't start (M1-09 record).
import './guard.ts';
import { basename } from 'node:path';
import { PREVIEW_HOST_FLAG } from '@draft-tide/contracts';
import { PREVIEW_HOST_EXECUTABLE } from '@draft-tide/engine-client';
import { runPreviewHost } from '../preview-host/host.ts';
import { runApp } from './app.ts';
import { BUILD } from './build-info.ts';

function refuse(message: string): never {
  process.stderr.write(`Draft Tide: ${message}\n`);
  process.exit(2);
}

const previewMode = process.argv.includes(PREVIEW_HOST_FLAG);
if (BUILD.mode === 'release') {
  const isPreviewHost = basename(process.execPath, '.exe') === PREVIEW_HOST_EXECUTABLE;
  if (isPreviewHost && !previewMode) refuse('the Preview Host runs only when the Engine starts it');
  if (!isPreviewHost && previewMode) refuse(`refusing ${PREVIEW_HOST_FLAG}: the app itself never renders previews`);
}
if (previewMode) runPreviewHost();
else runApp();
