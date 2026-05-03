import { Show, type Accessor, type JSX } from 'solid-js';
import LogWindow from '../components/LogWindow';
import type { Log } from '../services/log';

export type BadgeKind = 'lock' | 'running';
export interface BadgeState {
  kind: BadgeKind;
  text: string;
}

interface ProcessTabProps {
  name: string;
  topic: string;
  // Null means no badge ('ready'). lock + text shows the warm 🔒 badge
  // with text as the gating reason. running shows the teal pill.
  badge: Accessor<BadgeState | null>;
  log: Log;
  children?: JSX.Element;
}

export default function ProcessTab(props: ProcessTabProps) {
  return (
    <div class="proc">
      <div class="head">
        <h2 classList={{ disabled: props.badge()?.kind === 'lock' }}>
          {props.name}
        </h2>
        <Show when={props.badge()?.kind === 'lock'}>
          <span class="badge locked">🔒 {props.badge()!.text}</span>
        </Show>
        <Show when={props.badge()?.kind === 'running'}>
          <span class="badge running">{props.badge()!.text}</span>
        </Show>
      </div>
      <div class="interactive">{props.children}</div>
      <LogWindow lines={props.log.lines} topic={props.topic} />
    </div>
  );
}
