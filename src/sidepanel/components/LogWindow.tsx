import { For, Show, createEffect, createSignal, type Accessor } from 'solid-js';
import type { LogLine } from '../services/log';

interface LogWindowProps {
  lines: Accessor<LogLine[]>;
  topic: string;
}

const SLACK_PX = 4;

export default function LogWindow(props: LogWindowProps) {
  let logEl: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(true);
  const [unread, setUnread] = createSignal(0);
  let lastSeenLength = 0;

  // Track new-line arrivals; scroll if pinned, otherwise increment unread.
  createEffect(() => {
    const cur = props.lines().length;
    const delta = cur - lastSeenLength;
    lastSeenLength = cur;
    if (delta <= 0) return;
    if (pinned()) {
      queueMicrotask(() => {
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      });
      setUnread(0);
    } else {
      setUnread((u) => u + delta);
    }
  });

  const onScroll = () => {
    if (!logEl) return;
    const atBottom =
      logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < SLACK_PX;
    setPinned(atBottom);
    if (atBottom) setUnread(0);
  };

  const pinAndScroll = () => {
    if (!logEl) return;
    logEl.scrollTop = logEl.scrollHeight;
    setPinned(true);
    setUnread(0);
  };

  return (
    <div class="log-wrap">
      <div class="log-head">
        <span>log · {props.topic}</span>
        <div class="dots">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div
        class="log"
        ref={(el) => (logEl = el)}
        role="log"
        aria-live="polite"
        onScroll={onScroll}
      >
        <For each={props.lines()}>
          {(line) => (
            <div class="line">
              <span class="ts">{line.ts}</span>
              <span class={`lvl ${line.level}`}>[{line.level}]</span>
              <span class="msg">{line.msg}</span>
            </div>
          )}
        </For>
        <div class="line">
          <span class="ts">&nbsp;</span>
          <span class="lvl" />
          <span class="msg">
            <span class="cursor" />
          </span>
        </div>
      </div>
      <Show when={!pinned() && unread() > 0}>
        <button type="button" class="pinned-pill" onClick={pinAndScroll}>
          ↓ {unread()} new
        </button>
      </Show>
    </div>
  );
}
