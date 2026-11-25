'use strict';
// Setup checklist shown on the home page until everything is done (or hidden).
// Pure: index.js gathers the facts.
function compute({ isAdmin, twoFactor, linuxUser, bindSkipped, https, backups, alerts, updatesCheckedAt, now = Date.now() }) {
  const items = [
    { id: '2fa', label: 'Secure your login with two-factor authentication', done: !!twoFactor, href: '#/settings/security', cta: 'Set up 2FA' },
    { id: 'linux', label: 'Link your Linux account', done: !!linuxUser, href: '#/settings/account', cta: 'Link account', optional: !!bindSkipped },
  ];
  if (isAdmin) {
    items.push(
      { id: 'https', label: 'Serve the dashboard over HTTPS or keep it on localhost / a VPN', done: !!https, href: '#/proxy', cta: 'Open Proxy' },
      { id: 'backups', label: 'Set up a backup', done: backups > 0, href: '#/backup', cta: 'Add backup' },
      { id: 'alerts', label: 'Turn on alerts (email, Telegram, Discord, ntfy or webhook)', done: !!alerts, href: '#/settings/alerts', cta: 'Set up alerts' },
      { id: 'updates', label: 'Check for updates', done: !!updatesCheckedAt && now - updatesCheckedAt < 14 * 86400000, href: '#/updates', cta: 'Check now' },
    );
  }
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, complete: done === items.length };
}
module.exports = { compute };
