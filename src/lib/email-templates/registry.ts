import type { ComponentType } from "react";

export interface TemplateEntry {
  component: ComponentType<any>;
  subject: string | ((data: Record<string, any>) => string);
  displayName?: string;
  previewData?: Record<string, any>;
  /** Fixed recipient — overrides caller-provided recipientEmail when set. */
  to?: string;
}

/**
 * Template registry — maps template names to their React Email components.
 * Import and register new templates here after creating them in this directory.
 *
 * Example:
 *   import { template as welcomeTemplate } from './welcome'
 *   // then add to TEMPLATES: 'welcome': welcomeTemplate
 */
import { CaseReminderEmail } from "./case-reminder";
import { template as teamInviteTemplate } from "./team-invite";
import { ResourceContactEmail } from "./resource-contact";
import { template as adminSubscriptionAlertTemplate } from "./admin-subscription-alert";

export const TEMPLATES: Record<string, TemplateEntry> = {
  "case-reminder": {
    component: CaseReminderEmail,
    subject: (data) => `Recordatorio: ${data.itemTitle ?? "expediente"}`,
  },
  "team-invite": teamInviteTemplate,
  "resource-contact": {
    component: ResourceContactEmail,
    subject: (data) => String(data.subject || "Resource contact"),
  },
  "admin-subscription-alert": adminSubscriptionAlertTemplate,
};
