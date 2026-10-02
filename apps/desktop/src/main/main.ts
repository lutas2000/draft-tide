// The app binary's entry. guard.ts runs first in every mode (it refuses
// debugging switches). Then either the GUI app, or, when the Engine started
// this binary with --dt-preview-host, the isolated Preview Host: it renders
// what the Engine sends over its pipe and never opens a window, the Engine
// channel or anything of the GUI's.
import './guard.ts';
import { PREVIEW_HOST_FLAG } from '@draft-tide/contracts';
import { runPreviewHost } from '../preview-host/host.ts';
import { runApp } from './app.ts';

if (process.argv.includes(PREVIEW_HOST_FLAG)) runPreviewHost();
else runApp();
