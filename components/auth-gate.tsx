import { ArrowUpRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SignInForm } from "./sign-in-form";

export function AuthGate({
  configured,
  form,
}: {
  configured: boolean;
  form?: ReactNode;
}) {
  return (
    <main className="auth-layout min-h-[100svh] grid grid-cols-[1.08fr_1fr] max-[740px]:grid-cols-[1fr]">
      <section className="auth-story [background:#edf0e4] p-[43px_8%_25px] min-h-[100svh] flex flex-col relative overflow-hidden max-[1200px]:pl-[9%] max-[1200px]:pr-[9%] max-[740px]:min-h-[auto] max-[740px]:p-[25px_30px_27px]">
        <Link
          className="wordmark flex items-center gap-[11px] [font-family:var(--serif)] [font-size:31px] font-semibold tracking-[-1.2px]"
          href="/"
          aria-label="Brain home"
        >
          <span className="brand-mark inline-flex w-[37px] h-[37px] rounded-[11px] bg-primary items-center justify-center text-background [font-family:var(--serif)] [font-size:34px] leading-[1] pb-[6px] tracking-[-3px] pr-[3px]">
            b.
          </span>{" "}
          brain
          <span className="wordmark-label [font-family:var(--sans)] [font-size:9px] tracking-[.17em] font-medium ml-[23px] pl-6 [border-left:1px_solid_#cbd2c0] text-muted-foreground max-[1200px]:hidden">
            YOUR KNOWLEDGE, CONNECTED
          </span>
        </Link>
        <div className="auth-intro p-[90px_0_50px] relative z-[1] min-[1600px]:pt-30 max-[960px]:pt-[85px] max-[740px]:p-[50px_0_25px]">
          <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
            A PLACE FOR WHAT YOU KNOW
          </span>
          <h1>
            Good thoughts
            <br />
            deserve a<br />
            <em>longer life.</em>
          </h1>
          <p>
            A second brain that grows with your conversations. One page for each
            person, project, and idea. Connected, considered, and yours.
          </p>
        </div>
        <div className="auth-principles flex gap-[25px] [font-size:10px] mt-auto pb-15 [color:#606d52] relative z-[1] max-[1200px]:gap-[14px] max-[1200px]:[font-size:9px] max-[960px]:flex-wrap max-[960px]:gap-[12px_20px] max-[740px]:pb-[0] max-[740px]:pt-[13px] max-[740px]:gap-[22px] max-[460px]:gap-3 max-[460px]:[font-size:8px]">
          <span>
            <CircleCheck size={15} /> Your infrastructure
          </span>
          <span>
            <CircleCheck size={15} /> Any agent
          </span>
          <span>
            <CircleCheck size={15} /> Open by design
          </span>
        </div>
        <div className="auth-page-number flex justify-between [font-size:8px] tracking-[.12em] [color:#7f8c71] pt-5 [border-top:1px_solid_#d4ddc8] relative z-[1] max-[740px]:hidden">
          EST. 2026 <span>01 / THE KNOWLEDGE DESK</span>
        </div>
      </section>
      <section
        className="auth-entry flex justify-center items-center p-[60px_50px] max-[960px]:p-[45px_35px] max-[740px]:p-[47px_30px]"
        aria-label={configured ? "Sign in" : "Set up Brain"}
      >
        <div className="auth-entry-inner max-w-[340px] w-full [animation:enter_.6s_ease-out] max-[740px]:max-w-[410px]">
          <div
            className="small-orbit w-[49px] h-[49px] relative mb-8 max-[740px]:hidden"
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
            YOUR PRIVATE WORKSPACE
          </span>
          <h2>{configured ? "Welcome back." : "A home for your brain."}</h2>
          <p>
            {configured
              ? "Sign in to pick up the thread."
              : "Your workspace is ready to connect to your infrastructure. Complete the setup to begin."}
          </p>
          {configured ? (
            (form ?? <SignInForm />)
          ) : (
            <div className="setup-steps mt-[30px]">
              <div>
                <span>01</span>
                <p>
                  <strong>Connect your database</strong>Add your Neon connection
                  and run the migrations.
                </p>
              </div>
              <div>
                <span>02</span>
                <p>
                  <strong>Configure authentication</strong>Set the application
                  URL, auth secret, and owner email.
                </p>
              </div>
              <div>
                <span>03</span>
                <p>
                  <strong>Create your account</strong>Run the owner bootstrap
                  command in the setup guide.
                </p>
              </div>
              <a
                href="https://github.com/TommyBez/agent-brain#deployment"
                target="_blank"
                rel="noreferrer"
                className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
              >
                Deployment instructions <ArrowUpRight size={15} />
              </a>
            </div>
          )}
          <footer className="auth-footnote mt-[47px] pt-[22px] [border-top:1px_solid_var(--line)] text-center [color:#969b8e] [font-family:var(--serif)] italic [font-size:13px] max-[740px]:mt-[30px]">
            A quiet place. A connected mind.
          </footer>
        </div>
      </section>
    </main>
  );
}
