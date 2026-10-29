/**
 * What the landing page states about the running Job_Tool (8.10, 14.8).
 *
 * Requirements: 8.10, 14.8, 14.9.
 */

import { describe, expect, it } from 'vitest';

import { PRIVATE_USE_NOTICE_DE } from '../app-info.messages';
import { AppInfoService } from '../app-info.service';

describe('AppInfoService.appInfo', () => {
  it('states the activation of the Relevance_Service and the configured pair (8.10, 14.8)', () => {
    const service = new AppInfoService(
      { homeAddress: 'Hörkherstraße 1d, 80689 München', commuteThresholdMinutes: 45 },
      { activated: true },
    );

    expect(service.appInfo()).toEqual({
      relevanceServiceActivated: true,
      homeAddress: 'Hörkherstraße 1d, 80689 München',
      commuteThresholdMinutes: 45,
      privateUseNoticeDe: PRIVATE_USE_NOTICE_DE,
    });
  });

  it('states a deactivated Relevance_Service as such (14.8, 15.9)', () => {
    const service = new AppInfoService(
      { homeAddress: 'Beispielweg 2, 80331 München', commuteThresholdMinutes: 60 },
      { activated: false },
    );

    expect(service.appInfo().relevanceServiceActivated).toBe(false);
  });

  it('reads the configured values again on the next request (8.14)', () => {
    let commuteThresholdMinutes = 60;
    const config = {
      homeAddress: 'Beispielweg 2, 80331 München',
      get commuteThresholdMinutes() {
        return commuteThresholdMinutes;
      },
    };
    const service = new AppInfoService(config, { activated: false });

    expect(service.appInfo().commuteThresholdMinutes).toBe(60);

    commuteThresholdMinutes = 30;

    expect(service.appInfo().commuteThresholdMinutes).toBe(30);
  });
});

describe('the private-use notice (14.8)', () => {
  it('names the private purpose of use and no credential', () => {
    expect(PRIVATE_USE_NOTICE_DE).toContain('privaten Gebrauch');
    expect(PRIVATE_USE_NOTICE_DE).not.toMatch(/key|token|passwor/i);
  });
});
