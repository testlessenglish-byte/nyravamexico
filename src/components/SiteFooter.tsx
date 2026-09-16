import { Link } from "@tanstack/react-router";
import { NyravaLogo } from "./NyravaLogo";
import { useI18n } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Facebook, Linkedin, MessageCircle, Twitter } from "lucide-react";
import { getPublicSuperAdminSocialProfile } from "@/lib/social-profile.functions";

export function SiteFooter() {
  const { t } = useI18n();
  const getSocialProfile = useServerFn(getPublicSuperAdminSocialProfile);
  const { data: socialProfile } = useQuery({
    queryKey: ["public-super-admin-social-profile"],
    queryFn: () => getSocialProfile(),
    staleTime: 5 * 60 * 1000,
  });
  const socialLinks = socialProfile ? [
    { label: "LinkedIn", href: socialProfile.linkedin_url, icon: Linkedin },
    { label: "Discord", href: socialProfile.discord_url, icon: MessageCircle },
    { label: "X / Twitter", href: socialProfile.twitter_url, icon: Twitter },
    { label: "Facebook", href: socialProfile.facebook_url, icon: Facebook },
  ].filter((item): item is { label: string; href: string; icon: typeof Linkedin } => Boolean(item.href)) : [];
  return (
    <footer className="mt-24 border-t border-border/60">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <NyravaLogo size={42} withWordmark />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
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
            <li><Link to="/contact" className="hover:text-primary">{t("footer.link.contact")}</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border/60">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 px-6 py-6 text-xs text-muted-foreground md:flex-row md:items-center">
          <span>© {new Date().getFullYear()} Nyrava Intelligence México. {t("footer.copyright")}</span>
          <div className="flex flex-wrap items-center gap-3">
            {socialLinks.length > 0 && (
              <div className="flex items-center gap-2" aria-label={t("footer.socialLinks")}>
                <span className="hidden sm:inline">{socialProfile?.name}</span>
                {socialLinks.map(({ label, href, icon: Icon }) => (
                  <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                    aria-label={`${label} — ${socialProfile?.name}`}
                    className="grid h-8 w-8 place-items-center rounded-full border border-border/70 transition-colors hover:border-primary/50 hover:text-primary">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </a>
                ))}
              </div>
            )}
            <span className="font-mono text-[10px] tracking-[0.16em]">{t("footer.location")}</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

