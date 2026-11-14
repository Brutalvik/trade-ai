// Assertions for the test scripts: every check prints one line; finish() ends the process with a
// failing exit code if any check failed.
let pass = 0, fail = 0;
export function check(name: string, ok: boolean, detail: unknown = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
export function expect(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, ok ? (got as any) : `${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`);
}
export function finish(): never {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
