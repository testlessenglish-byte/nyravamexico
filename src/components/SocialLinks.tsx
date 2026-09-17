import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FaDiscord, FaFacebookF, FaLinkedinIn, FaXTwitter } from "react-icons/fa6";
import type { IconType } from "react-icons";
import { getPublicSuperAdminSocialProfile } from "@/lib/social-profile.functions";

type SocialLink = {
  label: string;
  href: string;
  icon: IconType;
  className: string;
};

export function SocialLinks({ className = "" }: { className?: string }) {
  const getSocialProfile = useServerFn(getPublicSuperAdminSocialProfile);
  const { data: socialProfile } = useQuery({
    queryKey: ["public-super-admin-social-profile"],
    queryFn: () => getSocialProfile(),
    staleTime: 5 * 60 * 1000,
  });

  const socialLinks: SocialLink[] = [
    {
      label: "LinkedIn",
      href: socialProfile?.linkedin_url || "https://linkedin.com/company/nyrava",
      icon: FaLinkedinIn,
      className: "bg-linkedin text-social-foreground hover:opacity-80 focus-visible:ring-linkedin",
    },
    {
      label: "Facebook",
      href: socialProfile?.facebook_url || "https://facebook.com/nyrava",
      icon: FaFacebookF,
      className: "bg-facebook text-social-foreground hover:opacity-80 focus-visible:ring-facebook",
    },
    {
      label: "X",
      href: socialProfile?.twitter_url || "https://x.com/nyrava",
      icon: FaXTwitter,
      className: "bg-twitter text-social-foreground hover:opacity-80 focus-visible:ring-twitter",
    },
    ...(socialProfile?.discord_url
      ? [{
          label: "Discord",
          href: socialProfile.discord_url,
          icon: FaDiscord,
          className: "bg-discord text-social-foreground hover:opacity-80 focus-visible:ring-discord",
        }]
      : []),
  ];

  return (
    <div className={`flex items-center justify-center gap-1.5 ${className}`} aria-label="Social media">
      {socialLinks.map(({ label, href, icon: Icon, className: brandClass }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          title={label}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${brandClass}`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}