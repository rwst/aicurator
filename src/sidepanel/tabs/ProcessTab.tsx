import { Show, type Accessor, type JSX } from 'solid-js';
import LogWindow from '../components/LogWindow';
import type { Log } from '../services/log';

export type RunStatus = 'locked' | 'ready' | 'running';

interface ProcessTabProps {
  name: string;
  topic: string;
  status: Accessor<RunStatus>;
  log: Log;
  children?: JSX.Element;
}

export default function ProcessTab(props: ProcessTabProps) {
  return (
    <div class="proc">
      <div class="head">
        <h2 classList={{ disabled: props.status() === 'locked' }}>
          {props.name}
        </h2>
        <Show when={props.status() === 'locked'}>
          <span class="badge locked">🔒 finish previous step</span>
        </Show>
        <Show when={props.status() === 'running'}>
          <span class="badge running">running…</span>
        </Show>
      </div>
      <div class="interactive">{props.children}</div>
      <LogWindow lines={props.log.lines} topic={props.topic} />
    </div>
  );
}
