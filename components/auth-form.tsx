import { Button } from "./button";
import { Field } from "./field";

type Props = {
  mode: "register" | "login";
  error?: string;
  username?: string;
  email?: string;
  /** Validated relative destination retained by the login form. */
  next?: string;
};

function PasswordField({ mode }: { mode: Props["mode"] }) {
  return (
    <div class="flex flex-col gap-vsp-2xs">
      <label for="password" class="text-small font-semibold">
        Password<span class="text-danger" aria-hidden="true"> *</span>
      </label>
      <input
        id="password"
        name="password"
        type="password"
        required
        minLength={8}
        autoComplete={mode === "register" ? "new-password" : "current-password"}
        class="w-full rounded-md border border-line bg-surface px-hsp-sm py-vsp-xs text-body"
      />
    </div>
  );
}

export function AuthForm({ mode, error, username, email, next }: Props) {
  const register = mode === "register";
  return (
    <section class="mx-auto flex w-full max-w-[30rem] flex-col gap-vsp-md">
      <div class="flex flex-col gap-vsp-2xs">
        <p class="text-micro font-semibold uppercase tracking-widest text-brand">Stillframe</p>
        <h1 class="text-title font-semibold tracking-tight">
          {register ? "Create an account" : "Sign in"}
        </h1>
        <p class="text-small text-ink-soft">
          {register ? "Share and collect photographs with your gallery." : "Welcome back to your gallery."}
        </p>
      </div>

      <form
        method="post"
        action={register ? "/register" : "/login"}
        class="flex flex-col gap-vsp-md rounded-lg border border-line bg-surface p-hsp-lg shadow-card"
      >
        {error ? (
          <p role="alert" class="rounded-md border border-danger bg-danger-soft px-hsp-sm py-vsp-xs text-small text-danger">
            {error}
          </p>
        ) : null}

        {!register && next && next !== "/" ? (
          <input type="hidden" name="next" value={next} />
        ) : null}

        {register ? (
          <Field
            id="username"
            name="username"
            label="Username"
            value={username ?? ""}
            required
            autoComplete="username"
            hint="3–24 lowercase letters, digits, hyphen or underscore."
          />
        ) : null}
        <Field
          id="email"
          name="email"
          label="Email"
          type="email"
          value={email ?? ""}
          required
          autoComplete="email"
        />
        <PasswordField mode={mode} />

        <Button>{register ? "Create account" : "Sign in"}</Button>

        <p class="text-center text-small text-ink-soft">
          {register ? "Already have an account? " : "Need an account? "}
          <a class="font-semibold text-brand underline hover:text-brand-strong" href={register ? "/login" : "/register"}>
            {register ? "Sign in" : "Register"}
          </a>
        </p>
      </form>
    </section>
  );
}
