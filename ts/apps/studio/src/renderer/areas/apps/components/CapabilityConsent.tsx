// What an app may do to the device beyond reading it (lib/appGrant.ts), and
// the checkbox the operator ticks to allow it (the Desktop's
// CapabilityConsent). Nothing is installed until it is ticked: the device
// itself refuses a package whose grant is missing.
import { ShieldAlert } from 'lucide-react';

import { Checkbox } from '../../../components/ui';
import { useAppsT } from '../strings';

export function CapabilityConsent({
  capabilities,
  agreed,
  onAgree,
}: {
  capabilities: readonly string[];
  agreed: boolean;
  onAgree: (agreed: boolean) => void;
}) {
  const t = useAppsT();
  if (!capabilities.length) return null;
  return (
    <div className="notice warning apps-permissions capability-consent" role="group" aria-label={t('appConsentTitle')}>
      <div>
        <strong className="capability-consent-title">
          <ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />
          {t('appConsentTitle')}
        </strong>
        <ul>
          {capabilities.map((name) => (
            <li key={name}>
              <code className="mono">{name}</code> {t(`appConsent_${name}`)}
            </li>
          ))}
        </ul>
        <label className="apps-check capability-consent-check">
          <Checkbox checked={agreed} onChange={(event) => onAgree(event.target.checked)} />
          {t('appConsentAgree')}
        </label>
      </div>
    </div>
  );
}
