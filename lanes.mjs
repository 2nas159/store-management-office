// Agents Office — run lanes (STORE, 30 Oct 2026). A lane runs its jobs one at a time, in order; two lanes run beside each other.
// serve.mjs keeps two: "work" for drafts, reworks, routines, triggers and scheduled tasks, and "send" for the gated runs that
// carry out an APPROVE (by the owner or by a rule). A send no longer waits behind a long team draft, and sends still never overlap.

/** → enqueue(fn): fn runs after every job queued before it on this lane; a job that throws does not stop the lane */
export function lane() {
  let tail = Promise.resolve();
  const enqueue = fn => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; };
  return enqueue;
}
