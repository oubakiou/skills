#!/bin/bash
set -euo pipefail

npm run sync-shared:check
npm run check
npm run test
