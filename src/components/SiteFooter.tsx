import { Link } from "@tanstack/react-router";
import { NyravaLogo } from "./NyravaLogo";
import { useI18n } from "@/i18n";
import { SocialLinks } from "./SocialLinks";

export function SiteFooter() {
  const { t } = useI18n();
  return (
    <footer className="mt-24 border-t border-border/60">
      <div className="mx-auto grid min-w-0 max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-2">
          <NyravaLogo size={42} withWordmark />
          <p className="mt-4 max-w-sm break-words text-sm leading-relaxed text-muted-foreground">
            {t("footer.about")}
          </p>
          <p className="mt-6 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            <span className="tag-bracket">{t("footer.version")}</span>
          </p>
        </div>
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {t("footer.section.platform")}
          </h4>
          <ul className="mt-4 space-y-2 text-sm text-foreground/80">
            <li><Link to="/about" className="hover:text-primary">{t("footer.link.about")}</Link></li>
            <li><Link to="/platform" className="hover:text-primary">{t("footer.link.platform")}</Link></li>
            <li><Link to="/modules" className="hover:text-primary">{t("footer.link.modules")}</Link></li>
            <li><Link to="/how-it-works" className="hover:text-primary">{t("footer.link.howItWorks")}</Link></li>
            <li><Link to="/resources" className="hover:text-primary">{t("footer.link.resources")}</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {t("footer.section.care")}
          </h4>
          <ul className="mt-4 space-y-2 text-sm text-foreground/80">
            <li><Link to="/product/$slug" params={{ slug: "comprehensive-care" }} className="hover:text-primary">{t("footer.link.care")}</Link></li>
            <li><Link to="/product/$slug" params={{ slug: "community-support" }} className="hover:text-primary">{t("footer.link.support")}</Link></li>
            <li><Link to="/product/$slug" params={{ slug: "talk-to-cases" }} className="hover:text-primary">{t("footer.link.talk")}</Link></li>
          </ul>
        </div>
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {t("footer.section.legal")}
          </h4>
          <ul className="mt-4 space-y-2 text-sm text-foreground/80">
            <li><Link to="/security" className="hover:text-primary">{t("footer.link.security")}</Link></li>
            <li><Link to="/trust" className="hover:text-primary">{t("footer.link.trust")}</Link></li>
            <li><Link to="/responsible-ai" className="hover:text-primary">{t("footer.link.responsibleAi")}</Link></li>
            <li><Link to="/privacy" className="hover:text-primary">{t("footer.link.privacy")}</Link></li>
            <li><Link to="/terms" className="hover:text-primary">{t("footer.link.terms")}</Link></li>
            <li><a href="mailto:contact@mexico.nyrava.com" className="hover:text-primary">{t("footer.link.contact")}</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border/60">
         <div className="mx-auto flex min-w-0 max-w-7xl flex-col items-start justify-between gap-3 px-4 py-6 text-xs text-muted-foreground sm:px-6 md:flex-row md:items-center">
           <span className="break-words">© {new Date().getFullYear()} Nyrava Intelligence México. {t("footer.copyright")}</span>
           <div className="flex min-w-0 flex-wrap items-center gap-3">
            <SocialLinks />
            <span className="font-mono text-[10px] tracking-[0.16em]">{t("footer.location")}</span>
          </div>
        </div>
      </div>
    </footer>
  );
}


