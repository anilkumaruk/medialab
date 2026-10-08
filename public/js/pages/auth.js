import { api } from '../api.js';
import { esc, toast, toastError, modal, withButton, showFieldError } from '../ui.js';

function layout(inner) {
  return `<div class="auth">
    <aside class="auth-brand">
      <h1>MediaLab</h1>
      <p class="tag">Equipment access, simplified.</p>
      <ul>
        <li>Browse live inventory</li>
        <li>Request with one click</li>
        <li>Track every approval</li>
        <li>Return with barcode check</li>
      </ul>
      <p class="flow">Request › Approve › Issue › Return › Log</p>
      <span class="orb" style="width:220px;height:220px;background:#2563EB;right:-60px;bottom:120px"></span>
      <span class="orb" style="width:130px;height:130px;background:#0EA5E9;right:-30px;bottom:70px"></span>
      <span class="orb" style="width:260px;height:260px;background:#0F9488;left:-90px;bottom:-140px"></span>
    </aside>
    <main class="auth-main">${inner}</main>
  </div>`;
}

const field = (name, label, attrs = '', extra = '') => `
  <div class="field">
    <label for="f-${name}">${label}</label>
    <input class="input" id="f-${name}" name="${name}" ${attrs}>
    ${extra}
    <div class="field-error"></div>
  </div>`;

export const TERMS_HTML = `<div class="terms">
  <ol>
    <li>Equipment may be taken <strong>only after</strong> the request is approved at both Level 1 and Level 2.</li>
    <li>Each item is issued and returned against its barcode. You are responsible for every item issued to you until the Media Lab verifies its return.</li>
    <li>Handle all equipment with care. <strong>Damage, loss or missing accessories may result in a fine</strong> as decided by the Media Lab.</li>
    <li>Return equipment by the approved date and time, or apply for a renewal before it is due. Overdue returns are logged and may affect future requests.</li>
    <li>Equipment must be used only for the purpose stated in the request.</li>
  </ol>
</div>`;

function otpTimer(btn, seconds) {
  let left = seconds;
  btn.disabled = true;
  const label = btn.dataset.label;
  btn.textContent = `Resend in ${left}s`;
  const t = setInterval(() => {
    left -= 1;
    if (!btn.isConnected || left <= 0) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = label === 'Send code' ? 'Resend' : label;
      return;
    }
    btn.textContent = `Resend in ${left}s`;
  }, 1000);
}

async function sendOtp(btn, body) {
  try {
    const res = await withButton(btn, () => api('/auth/otp', { body }));
    otpTimer(btn, res.resendIn || 30);
    if (res.devCode) toast(`Dev mode – your ${body.channel} code is <code>${esc(res.devCode)}</code>`, 'info', 12000);
    else toast(`Code sent to your ${body.channel}`, 'success');
    return true;
  } catch (e) {
    if (e.data?.retryAfter) otpTimer(btn, e.data.retryAfter);
    toastError(e);
    return false;
  }
}

// ---------------- Login ----------------

export async function login(view, ctx) {
  document.title = 'Log in · MediaLab';
  const domain = ctx.config.allowedDomains[0] || 'alliance.edu.in';
  view.innerHTML = layout(`
    <div class="auth-card narrow">
      <h2>Welcome back</h2>
      <p class="sub">Log in to the equipment portal</p>
      <form id="login" class="stack" novalidate>
        ${field('email', 'Email', `type="email" autocomplete="username" placeholder="name@${esc(domain)}" required`)}
        ${field('password', 'Password', 'type="password" autocomplete="current-password" placeholder="••••••••" required')}
        <div class="field">
          <label for="f-captcha">Captcha</label>
          <div class="captcha-row">
            <img id="cap-img" alt="Captcha image">
            <button type="button" class="btn btn-secondary" id="cap-new" title="Show a new captcha" aria-label="New captcha">↻</button>
            <input class="input" id="f-captcha" name="captcha" placeholder="Type the characters" autocomplete="off" autocapitalize="characters" maxlength="6" required>
          </div>
          <div class="field-error"></div>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Log In</button>
        <div class="row wrap" style="justify-content:space-between">
          <a href="#/forgot">Forgot password?</a>
          <span class="muted">New here? <a href="#/register">Create an account</a></span>
        </div>
      </form>
      ${ctx.config.devMode ? `<div class="demo-box">
        <div class="strong" style="margin-bottom:6px">Demo accounts (development only)</div>
        <div class="stack-sm">
          <div>Student: <button class="link-btn" data-demo="anil.kumar@${esc(domain)}|Student@1234">anil.kumar@${esc(domain)}</button></div>
          <div>Level 1 approver: <button class="link-btn" data-demo="ganesh@${esc(domain)}|Admin@1234">ganesh@${esc(domain)}</button></div>
          <div>Level 2 approver: <button class="link-btn" data-demo="pritha@${esc(domain)}|Admin@1234">pritha@${esc(domain)}</button></div>
        </div>
      </div>` : ''}
    </div>`);

  const form = view.querySelector('#login');
  let captchaId = null;
  async function loadCaptcha() {
    try {
      const c = await api('/auth/captcha');
      captchaId = c.id;
      view.querySelector('#cap-img').src = c.image;
      form.captcha.value = '';
    } catch (e) {
      toastError(e);
    }
  }
  view.querySelector('#cap-new').addEventListener('click', loadCaptcha);
  view.querySelectorAll('[data-demo]').forEach((b) =>
    b.addEventListener('click', () => {
      const [email, pw] = b.dataset.demo.split('|');
      form.email.value = email;
      form.password.value = pw;
      form.captcha.focus();
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    await withButton(btn, async () => {
      try {
        const { user } = await api('/auth/login', {
          body: { email: form.email.value.trim(), password: form.password.value, captchaId, captcha: form.captcha.value.trim() },
        });
        ctx.setUser(user);
        const next = ctx.query.get('next');
        ctx.go(next && next.startsWith('/') ? next : user.role === 'admin' ? '/admin' : '/home');
      } catch (err) {
        const fieldName = err.data?.field || (err.status === 401 ? 'password' : null);
        showFieldError(form, fieldName, err.message);
        toastError(err);
        loadCaptcha();
      }
    });
  });

  await loadCaptcha();
  form.email.focus();
}

// ---------------- Register ----------------

export async function register(view, ctx) {
  document.title = 'Create account · MediaLab';
  const domains = ctx.config.allowedDomains;
  const domain = domains[0] || 'alliance.edu.in';
  const otpBtn = (ch) => `<button type="button" class="btn btn-secondary btn-sm" data-otp="${ch}" data-label="Send code">Send code</button>`;

  view.innerHTML = layout(`
    <div class="auth-card">
      <h2>Create your account</h2>
      <p class="sub">Use your institution email to get verified.</p>
      <form id="reg" novalidate>
        <div class="form-grid">
          <div class="span-3">${field('name', 'Full name', 'autocomplete="name" placeholder="Anil Kumar" maxlength="80"')}</div>
          <div class="span-3">${field('phone', 'Phone number', 'type="tel" autocomplete="tel" placeholder="+91 98xxxxxx10"')}</div>
          <div class="span-3">${field('email', 'Institution e-mail', `type="email" autocomplete="email" placeholder="name@${esc(domain)}"`)}</div>
          <div class="span-3 field">
            <span class="label">Profession</span>
            <div class="seg" id="prof"><button type="button" class="active" data-p="student">Student</button><button type="button" data-p="faculty">Faculty</button></div>
          </div>
          <div class="span-2" id="batch-wrap">${field('batch', 'Batch', 'placeholder="2024-2028" maxlength="20"')}</div>
          <div class="span-2">${field('department', 'Department', 'placeholder="CSE" maxlength="80"')}</div>
          <div class="span-2" id="school-wrap">${field('school', 'School', 'placeholder="Advanced Computing" maxlength="120"')}</div>
          <div class="${ctx.config.phoneOtp ? 'span-3' : 'span-6'} field">
            <label for="f-emailOtp">Email OTP</label>
            <div class="input-group"><input class="input" id="f-emailOtp" name="emailOtp" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">${otpBtn('email')}</div>
            <div class="field-error"></div>
          </div>
          ${ctx.config.phoneOtp ? `<div class="span-3 field">
            <label for="f-phoneOtp">Phone OTP</label>
            <div class="input-group"><input class="input" id="f-phoneOtp" name="phoneOtp" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">${otpBtn('phone')}</div>
            <div class="field-error"></div>
          </div>` : ''}
          <div class="span-3">${field('password', 'Password', 'type="password" autocomplete="new-password" placeholder="Min 8 characters"')}</div>
          <div class="span-3">${field('confirmPassword', 'Confirm password', 'type="password" autocomplete="new-password" placeholder="Re-enter password"')}</div>
          <div class="span-6 field">
            <label class="check"><input type="checkbox" name="acceptTerms"> <span>I accept the <button type="button" class="link-btn" id="terms">Terms &amp; Equipment Damage Policy</button></span></label>
            <div class="field-error"></div>
          </div>
          <div class="span-6"><button class="btn btn-primary btn-block btn-lg" type="submit">Verify &amp; Create Account</button></div>
          <div class="span-6" style="text-align:center"><a href="#/login" class="strong">Already registered? Log in</a></div>
        </div>
      </form>
    </div>`);

  const form = view.querySelector('#reg');
  let profession = 'student';

  view.querySelector('#prof').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    profession = b.dataset.p;
    view.querySelectorAll('#prof button').forEach((x) => x.classList.toggle('active', x === b));
    view.querySelector('#batch-wrap').classList.toggle('hidden', profession === 'faculty');
    view.querySelector('#school-wrap').className = profession === 'faculty' ? 'span-4' : 'span-2';
  });

  view.querySelector('#terms').addEventListener('click', () => {
    const m = modal({
      title: 'Terms & Equipment Damage Policy',
      body: TERMS_HTML,
      footer: '<button class="btn btn-ghost" data-close>Close</button><button class="btn btn-primary" data-accept>I accept</button>',
    });
    m.el.querySelector('[data-accept]').addEventListener('click', () => {
      form.acceptTerms.checked = true;
      m.close();
    });
  });

  // Inline institution domain check
  const emailOk = (v) => !domains.length || domains.some((d) => v.endsWith('@' + d) || v.endsWith('.' + d));
  const checkEmail = () => {
    const v = form.email.value.trim().toLowerCase();
    const wrap = form.email.closest('.field');
    const bad = v && v.includes('@') && !emailOk(v);
    wrap.classList.toggle('error', !!bad);
    wrap.querySelector('.field-error').textContent = bad ? `Use your institution email (@${domain})` : '';
    return !bad;
  };
  form.email.addEventListener('blur', checkEmail);
  form.email.addEventListener('input', () => form.email.closest('.field').classList.contains('error') && checkEmail());

  view.querySelectorAll('[data-otp]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const channel = btn.dataset.otp;
      const target = channel === 'email' ? form.email.value.trim() : form.phone.value.trim();
      if (!target) {
        showFieldError(form, channel, channel === 'email' ? 'Enter your institution email first' : 'Enter your phone number first');
        return;
      }
      if (channel === 'email' && !checkEmail()) return;
      if (await sendOtp(btn, { channel, target, purpose: 'register' })) form[channel === 'email' ? 'emailOtp' : 'phoneOtp'].focus();
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = {
      name: f.name.value,
      phone: f.phone.value,
      email: f.email.value,
      profession,
      batch: f.batch.value,
      department: f.department.value,
      school: f.school.value,
      emailOtp: f.emailOtp.value.trim(),
      phoneOtp: f.phoneOtp?.value.trim() || '',
      password: f.password.value,
      confirmPassword: f.confirmPassword.value,
      acceptTerms: f.acceptTerms.checked,
    };
    if (!body.acceptTerms) {
      showFieldError(form, 'acceptTerms', 'Account cannot be created until the damage policy is accepted');
      return;
    }
    await withButton(form.querySelector('[type=submit]'), async () => {
      try {
        const { user } = await api('/auth/register', { body });
        ctx.setUser(user);
        toast(`Welcome, ${esc(user.name.split(' ')[0])}! Your account is verified.`, 'success');
        ctx.go('/home');
      } catch (err) {
        showFieldError(form, err.data?.field, err.message);
        toastError(err);
      }
    });
  });

  form.elements.name.focus();
}

// ---------------- Forgot password ----------------

export async function forgot(view, ctx) {
  document.title = 'Reset password · MediaLab';
  const domain = ctx.config.allowedDomains[0] || 'alliance.edu.in';
  view.innerHTML = layout(`
    <div class="auth-card narrow">
      <h2>Reset your password</h2>
      <p class="sub">We'll email a 6-digit code to your institution address.</p>
      <form id="fp" class="stack" novalidate>
        <div class="field">
          <label for="f-email">Email</label>
          <div class="input-group"><input class="input" id="f-email" name="email" type="email" placeholder="name@${esc(domain)}" autocomplete="username"><button type="button" class="btn btn-secondary btn-sm" data-send data-label="Send code">Send code</button></div>
          <div class="field-error"></div>
        </div>
        ${field('otp', 'Email code', 'inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code"')}
        ${field('password', 'New password', 'type="password" autocomplete="new-password" placeholder="Min 8 characters"')}
        ${field('confirmPassword', 'Confirm new password', 'type="password" autocomplete="new-password"')}
        <button class="btn btn-primary btn-block btn-lg" type="submit">Reset password</button>
        <div style="text-align:center"><a href="#/login" class="strong">Back to log in</a></div>
      </form>
    </div>`);
  const form = view.querySelector('#fp');
  view.querySelector('[data-send]').addEventListener('click', async (e) => {
    const email = form.email.value.trim();
    if (!email) return showFieldError(form, 'email', 'Enter your email first');
    if (await sendOtp(e.currentTarget, { channel: 'email', target: email, purpose: 'reset' })) form.otp.focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withButton(form.querySelector('[type=submit]'), async () => {
      try {
        await api('/auth/reset', {
          body: { email: form.email.value.trim(), otp: form.otp.value.trim(), password: form.password.value, confirmPassword: form.confirmPassword.value },
        });
        toast('Password updated. Log in with your new password.', 'success');
        ctx.go('/login');
      } catch (err) {
        showFieldError(form, err.data?.field === 'emailOtp' ? 'otp' : err.data?.field, err.message);
        toastError(err);
      }
    });
  });
  form.email.focus();
}
