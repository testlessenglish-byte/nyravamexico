// Admin notification: a new subscriber finished signup/trial start.
// Fixed recipient — always the business admin inbox.
import React from 'react'
import { Body, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components'
import type { TemplateEntry } from './registry'

interface Props {
  customerEmail?: string
  customerName?: string
  plan?: string
  status?: string
  subscriptionId?: string
}

const Email = ({ customerEmail, customerName, plan, status, subscriptionId }: Props) => (
  <Html lang="es" dir="ltr">
    <Head />
    <Preview>Nueva suscripción en Nyrava México</Preview>
    <Body style={main}>
      <Container style={container}>
        <Text style={brand}>NYRAVA MÉXICO</Text>
        <Heading style={h1}>Nueva suscripción</Heading>
        <Text style={text}>Un nuevo cliente se ha suscrito en la plataforma.</Text>
        <Section style={card}>
          <Text style={row}>
            <strong>Cliente:</strong>{' '}
            {customerName ? `${customerName} — ` : ''}
            {customerEmail || 'No disponible'}
          </Text>
          <Text style={row}>
            <strong>Plan:</strong> {plan || 'No especificado'}
          </Text>
          <Text style={row}>
            <strong>Estado:</strong> {status || 'activo'}
          </Text>
          {subscriptionId && (
            <Text style={row}>
              <strong>Suscripción Stripe:</strong> {subscriptionId}
            </Text>
          )}
        </Section>
        <Text style={text}>
          Puedes ver los detalles completos en el panel de administración → Suscripciones.
        </Text>
        <Hr style={hr} />
        <Text style={footer}>Notificación automática de Nyrava Intelligence México</Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (data: Record<string, any>) =>
    `Nueva suscripción${data?.plan ? ` — ${data.plan}` : ''} · Nyrava México`,
  displayName: 'Alerta de nueva suscripción (admin)',
  previewData: {
    customerEmail: 'cliente@despacho.mx',
    customerName: 'Cliente de ejemplo',
    plan: 'Nyrava Pro',
    status: 'active',
    subscriptionId: 'sub_ejemplo',
  },
  to: 'admin@mexico.nyrava.com',
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, Helvetica, sans-serif' }
const container = { padding: '28px 24px', maxWidth: '560px', margin: '0 auto' }
const brand = {
  fontSize: '11px',
  letterSpacing: '3px',
  color: '#6b7280',
  marginBottom: '4px',
} as React.CSSProperties
const h1 = { fontSize: '22px', color: '#111827', margin: '8px 0 12px' }
const text = { fontSize: '14px', lineHeight: '22px', color: '#374151' }
const card = {
  backgroundColor: '#f8f7fc',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '14px 18px',
  margin: '16px 0',
} as React.CSSProperties
const row = { fontSize: '14px', lineHeight: '24px', color: '#111827', margin: '2px 0' }
const hr = { borderColor: '#e5e7eb', margin: '20px 0 12px' }
const footer = { fontSize: '11px', color: '#9ca3af' }
