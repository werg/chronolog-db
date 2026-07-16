#!/usr/bin/env bash
set -euo pipefail

export CC="${CC:-clang}"
export CXX="${CXX:-clang++}"
export CFLAGS="${CFLAGS:-} -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined"
export CXXFLAGS="${CXXFLAGS:-} -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined"
export LDFLAGS="${LDFLAGS:-} -fsanitize=address,undefined"
export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=1:abort_on_error=1:strict_string_checks=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1:halt_on_error=1}"

pnpm rebuild @dolthub/doltlite

asan_library="$($CC -print-file-name=libclang_rt.asan-x86_64.so)"
if [[ -f "$asan_library" ]]; then
  export LD_PRELOAD="$asan_library${LD_PRELOAD:+:$LD_PRELOAD}"
fi

pnpm vitest run \
  packages/materializer-doltlite/src/sql-materializer.integration.test.ts \
  packages/materializer-doltlite/src/sql-security.test.ts \
  test/materializer-publication-crash.integration.test.ts
