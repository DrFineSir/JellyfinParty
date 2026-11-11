#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
npm run test:syntax
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
dotnet run --project tests/Core/Core.csproj -c Release
python3 scripts/run-integration.py
