#!/bin/bash
# Throwaway preview only. No real catalog/settings files are read or written.
cd -- "$(dirname -- "$0")/../../.." || exit 1
node --import tsx packages/pi-better-subagents/prototype-catalog-preferences/selected.ts
