import { useState } from 'react';
import { bridge } from '../api.ts';
import { errorText } from '../format.ts';
import { useUi } from '../store.ts';
import { Button } from './ui.tsx';

/** What the app knows about the engine, and the one thing the person can do about it (retry, or pair). */
export function ConnectionBanner() {
  const connection = useUi((state) => state.connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (connection.phase === 'connected' && connection.access === 'write') return null;

  const pair = async () => {
    setBusy(true);
    setError(undefined);
    const result = await bridge().pair();
    setBusy(false);
    if (!result.ok) setError(errorText(result.error));
  };

  let text: string;
  let action = null;
  if (connection.phase === 'connecting') text = '엔진에 연결하는 중…';
  else if (connection.phase === 'launching') text = '엔진을 시작하는 중…';
  else if (connection.phase === 'offline' || connection.phase === 'failed') {
    text = connection.message ?? '엔진에 연결되어 있지 않습니다.';
    action = (
      <Button small onClick={() => void bridge().retry()}>
        지금 다시 시도
      </Button>
    );
  } else if (connection.pairing !== undefined) {
    text = `엔진이 띄운 확인 창의 코드가 ${connection.pairing.code}인지 확인하고 [예]를 누르세요.`;
  } else {
    text = connection.message ?? '읽기 전용으로 연결되어 있습니다.';
    action = (
      <Button small kind="primary" disabled={busy} onClick={() => void pair()}>
        권한 연결
      </Button>
    );
  }

  const tone = connection.phase === 'connected' ? 'border-human/30 bg-human/10 text-human' : 'border-line bg-white text-muted';
  return (
    <div role="status" className={`flex flex-none items-center gap-3 border-b px-7 py-2 text-[13px] ${tone}`}>
      <span className="flex-1">
        {text}
        {connection.pairing !== undefined && (
          <b className="ml-2 font-mono text-[15px] tracking-widest" aria-label="확인 코드">
            {connection.pairing.code}
          </b>
        )}
      </span>
      {error !== undefined && <span className="text-failed">{error}</span>}
      {action}
    </div>
  );
}
