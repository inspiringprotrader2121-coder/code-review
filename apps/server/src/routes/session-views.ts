import { escapeHtml, pageShell } from './pages.js';

export type OAuthOptions = Readonly<{ github: boolean; google: boolean }>;

export function loginPage(
  next: string,
  error: string | undefined,
  csrf: string,
  options: OAuthOptions,
): string {
  const nextAttr = escapeHtml(next);
  const banner =
    error === 'rate'
      ? '<div class="banner error">Too many sign-in attempts. Try again in a few minutes.</div>'
      : error === 'csrf'
        ? '<div class="banner error">Your sign-in form expired. Please try again.</div>'
        : error === 'github'
          ? '<div class="banner error">GitHub sign-in was cancelled or could not be completed. Try again.</div>'
          : error === 'google'
            ? '<div class="banner error">Google sign-in was cancelled or could not be completed. Try again.</div>'
            : error
              ? '<div class="banner error">Incorrect email or password.</div>'
              : '';
  return pageShell(
    'Sign in',
    `<h1>Sign in to Orvex</h1>
    <p class="lead">Access your review dashboard and connected GitHub.</p>${banner}${socialAuthButtons(next, options)}
    <form method="post" action="/auth/login"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <input type="hidden" name="next" value="${nextAttr}" /><label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@example.com" />
      <label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" />
      <button type="submit">Sign in →</button></form>
    <p class="muted" style="margin-top:16px">New to Orvex? <a href="/auth/register?next=${encodeURIComponent(next)}">Create a free account</a></p>`,
  );
}

export function registerPage(
  next: string,
  error: string | undefined,
  csrf: string,
  options: OAuthOptions,
): string {
  const banner =
    error === 'rate'
      ? '<div class="banner error">Too many account-creation attempts. Try again later.</div>'
      : error === 'csrf'
        ? '<div class="banner error">Your registration form expired. Please try again.</div>'
        : error === 'email'
          ? '<div class="banner error">Enter a valid email address.</div>'
          : error === 'password'
            ? '<div class="banner error">Use a password between 12 and 1,024 characters.</div>'
            : error === 'match'
              ? '<div class="banner error">The passwords do not match.</div>'
              : error === 'exists'
                ? '<div class="banner error">An account already exists for that email. Please sign in.</div>'
                : error === 'disposable'
                  ? '<div class="banner error">Please use a permanent email address — disposable/temporary inboxes aren\'t accepted.</div>'
                  : error === 'terms'
                    ? '<div class="banner error">Please accept the Terms of Service and Privacy Policy to create an account.</div>'
                    : '';
  return pageShell(
    'Create your account',
    `<h1>Start free with Orvex</h1>
    <p class="lead">Create your account, then connect the GitHub repositories you want reviewed.</p>${banner}${socialAuthButtons(next, options)}
    <form method="post" action="/auth/register"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <input type="hidden" name="next" value="${escapeHtml(next)}" /><label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" />
      <label for="password">Password</label><input id="password" name="password" type="password" required minlength="12" autocomplete="new-password" />
      <p class="hint">At least 12 characters.</p><label for="confirm-password">Confirm password</label>
      <input id="confirm-password" name="confirmPassword" type="password" required minlength="12" autocomplete="new-password" />
      <label style="display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-size:13px;line-height:1.45"><input id="accepted-terms" name="acceptedTerms" value="1" type="checkbox" required style="margin-top:3px" />
      <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a> and acknowledge the <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span></label>
      <button type="submit">Create free account →</button></form>
    <p class="muted" style="margin-top:16px">Already have an account? <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in</a></p>`,
  );
}

export function mfaPage(error?: string): string {
  const banner =
    error === 'rate'
      ? '<div class="banner error">Too many attempts. Try again in a few minutes.</div>'
      : error
        ? '<div class="banner error">That authentication code was not accepted.</div>'
        : '';
  return pageShell(
    'Two-factor authentication',
    `<h1>Authentication code</h1>
    <p class="lead">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>${banner}
    <form method="post" action="/auth/2fa"><label for="code">Authentication code</label>
      <input id="code" name="code" type="text" required autofocus autocapitalize="characters" spellcheck="false" autocomplete="one-time-code" />
      <button type="submit">Continue</button></form>`,
  );
}

export function logoutPage(csrf: string): string {
  return pageShell(
    'Sign out',
    `<h1>Sign out of Orvex?</h1><p class="lead">You will need to sign in again to access your review dashboard.</p>
    <form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}" /><button type="submit">Sign out</button></form>`,
  );
}

function socialAuthButtons(next: string, options: OAuthOptions): string {
  const nextQuery = encodeURIComponent(next);
  const buttons = [
    options.google
      ? `<a class="btn secondary" href="/auth/google?next=${nextQuery}">Continue with Google</a>`
      : '',
    options.github
      ? `<a class="btn secondary" href="/auth/github?next=${nextQuery}">Continue with GitHub</a>`
      : '',
  ]
    .filter(Boolean)
    .join('');
  return buttons
    ? `${buttons}<p class="muted" style="text-align:center;margin:14px 0 -4px">or use your email</p>`
    : '';
}
