import { type JSX, createSignal, onCleanup, onMount } from 'solid-js';

const CHANNEL = 'aicurator-instance';
const PROBE_TIMEOUT_MS = 200;

interface InstanceGuardProps {
  children: JSX.Element;
}

// Single-instance lock via BroadcastChannel.
//
// On mount: post 'ping' and listen up to 200ms for an 'occupied' reply.
// - If 'occupied' arrives, we're a duplicate — render the splash.
// - If timeout passes silently, we claim the slot and answer all future
//   pings with 'occupied'.
//
// Try Again repeats the probe. Multi-instance support is a future TODO.
export default function InstanceGuard(props: InstanceGuardProps) {
  const [siblingDetected, setSiblingDetected] = createSignal(false);
  let bc: BroadcastChannel | null = null;
  let claimed = false;

  const close = () => {
    bc?.close();
    bc = null;
  };

  const probe = () => {
    close();
    setSiblingDetected(false);
    claimed = false;
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => {
      if (e.data === 'ping' && claimed) {
        bc?.postMessage('occupied');
      } else if (e.data === 'occupied' && !claimed) {
        setSiblingDetected(true);
        close();
      }
    };
    bc.postMessage('ping');
    setTimeout(() => {
      if (!siblingDetected()) claimed = true;
    }, PROBE_TIMEOUT_MS);
  };

  onMount(probe);
  onCleanup(close);

  return (
    <>
      {siblingDetected() ? (
        <div class="instance-splash" role="alertdialog" aria-modal="true">
          <h2>AICurator is already open</h2>
          <p>
            Close the other window first, then click <em>Try again</em>.
          </p>
          <button type="button" class="btn primary" onClick={probe}>
            Try again
          </button>
        </div>
      ) : (
        props.children
      )}
    </>
  );
}
