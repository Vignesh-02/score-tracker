// Must be the first import in index.js. ES modules load every import before
// running any code, so the APM agent has to start in its own module to be
// running before express, http and pg load; it can only monitor libraries
// that load after it starts.

// The agent reads APMINSIGHT_* settings from the environment
import 'dotenv/config';
import { createRequire } from 'node:module';
import AgentAPI from 'apminsight';

AgentAPI.config();

// The agent only wraps libraries loaded with require(), not with import.
// Loading them with require() here, right after it starts, gets them wrapped;
// later imports (including drizzle-orm's own import of pg) reuse these
// already-loaded, wrapped copies.
const require = createRequire(import.meta.url);
require('express');
require('pg');
