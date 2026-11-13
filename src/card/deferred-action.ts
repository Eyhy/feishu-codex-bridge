/**
 * Return from the SDK callback immediately so it can acknowledge the click.
 * Feishu may restore the pre-click card when that acknowledgement arrives;
 * updating the card before then can report success but disappear afterwards.
 * The short delay lets the ACK settle before any card updates begin.
 */
export function deferCardAction(
  action: () => void | Promise<void>,
  onError: (error: unknown) => void,
): void {
  setTimeout(() => {
    void Promise.resolve().then(action).catch(onError);
  }, 500);
}
