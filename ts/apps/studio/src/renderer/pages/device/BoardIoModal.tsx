// The IO Visualizer, ported from New-Horizons-Desktop pages/TerminalPage.tsx
// (BoardIoModal): the board's overview artwork beside a pin picker. Pins are
// picked in order (that order is the matrix order) and applied with
// set_matrix_layout, or copied as a terminal command.

import { useEffect, useState } from 'react';

import { copyText } from '../../areas/apps/lib/clipboard';
import { DEFAULT_BOARD_PROFILE, displayHardwareModel, type BoardPinSlot, type BoardProfile } from '../../lib/boardProfile';
import { useAreaT } from '../../areas/i18n';
import { DEVICE_SETTINGS_STRINGS } from './settingsStrings';

function togglePin(values: number[], value: number): number[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function pinCommand(analogPins: number[], selectPins: number[]): string {
  return `set-matrix-layout --analog-pins ${analogPins.join(',')} --select-pins ${selectPins.join(',')}`;
}

export function BoardIoModal({
  profile,
  initialAnalogPins,
  initialSelectPins,
  applyDisabled,
  onApply,
  onClose,
}: {
  profile: BoardProfile;
  initialAnalogPins: number[];
  initialSelectPins: number[];
  applyDisabled: boolean;
  onApply: (analogPins: number[], selectPins: number[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const ds = useAreaT(DEVICE_SETTINGS_STRINGS) as (key: string) => string;
  const [analog, setAnalog] = useState<number[]>(() => (initialAnalogPins.length ? initialAnalogPins : profile.defaultAnalogPins));
  const [select, setSelect] = useState<number[]>(() => (initialSelectPins.length ? initialSelectPins : profile.defaultSelectPins));
  const [status, setStatus] = useState('');
  const command = pinCommand(analog, select);
  const boardLabel = displayHardwareModel(profile.hardwareModel);
  const subtitle = profile.supportsIoVisualizer && profile.hardwareModel === DEFAULT_BOARD_PROFILE.hardwareModel ? ds('ioOrientation') : boardLabel;
  const incomplete = !analog.length || !select.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(pin: BoardPinSlot) {
    if (!pin.role || pin.gpio === undefined) return;
    setStatus('');
    if (pin.role === 'analog') setAnalog((current) => togglePin(current, Number(pin.gpio)));
    else setSelect((current) => togglePin(current, Number(pin.gpio)));
  }

  function pinList(pins: BoardPinSlot[], keyPrefix: string, chosen: number[]) {
    return (
      <ol>
        {pins.map((pin, index) => {
          const selectable = Boolean(pin.role) && pin.gpio !== undefined;
          const order = selectable ? chosen.indexOf(Number(pin.gpio)) + 1 : 0;
          const selected = order > 0;
          return (
            <li key={`${keyPrefix}-${index}`} className={selected ? 'selected' : ''}>
              <button type="button" className="io-pin-button" disabled={!selectable} onClick={() => toggle(pin)} aria-pressed={selectable ? selected : undefined}>
                <span className={selected ? 'io-pin-order' : undefined}>{selected ? order : index + 1}</span>
                <strong>{pin.label}</strong>
                <em>{pin.gpio !== undefined ? `GPIO ${pin.gpio}` : '-'}</em>
              </button>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel io-modal" role="dialog" aria-modal="true" aria-labelledby="io-modal-title">
        <div className="io-modal-header">
          <div>
            <h3 id="io-modal-title">{ds('ioConfigTitle')}</h3>
            <p>{subtitle}</p>
          </div>
          <button className="button" type="button" onClick={onClose}>
            {ds('ioConfigClose')}
          </button>
        </div>
        <div className="io-board-diagram">
          <div className="io-board-image">
            {profile.overviewAsset ? (
              <img src={profile.overviewAsset} alt={`${boardLabel} overview`} />
            ) : (
              <div className="io-board-placeholder">
                <strong>{boardLabel}</strong>
              </div>
            )}
          </div>
          <div className="io-config-panel">
            <div className="io-command-copy">
              <code>{command}</code>
              <div className="actions">
                <button
                  className="button primary"
                  type="button"
                  disabled={applyDisabled || incomplete}
                  onClick={() =>
                    void onApply(analog, select).then((ok) => {
                      if (ok) setStatus(ds('pinLayoutApplied'));
                    })
                  }
                >
                  {ds('applyPinLayout')}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={incomplete}
                  onClick={() =>
                    void copyText(command).then(
                      () => setStatus(ds('copied')),
                      () => setStatus(ds('copyFailed')),
                    )
                  }
                >
                  {ds('copyCommand')}
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    setAnalog(profile.defaultAnalogPins);
                    setSelect(profile.defaultSelectPins);
                    setStatus('');
                  }}
                >
                  {ds('selectDefaultPins')}
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    setAnalog([]);
                    setSelect([]);
                    setStatus('');
                  }}
                >
                  {ds('clearSelection')}
                </button>
              </div>
              {status ? <p className="io-status">{status}</p> : null}
            </div>
            <div className="io-selected-summary">
              <div>
                <span>{ds('analogPins')}</span>
                <strong>{analog.join(',') || '-'}</strong>
              </div>
              <div>
                <span>{ds('selectPins')}</span>
                <strong>{select.join(',') || '-'}</strong>
              </div>
            </div>
            {profile.supportsIoVisualizer ? (
              <div className="io-pin-table">
                <div>
                  <h4 title={profile.analogPinOrder.join(', ')}>{profile.analogPinHeading}</h4>
                  {pinList(profile.analogPinSlots, 'ana', analog)}
                </div>
                <div>
                  <h4 title={profile.digitalPinOrder.join(', ')}>{profile.digitalPinHeading}</h4>
                  {pinList(profile.digitalPinSlots, 'dig', select)}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
