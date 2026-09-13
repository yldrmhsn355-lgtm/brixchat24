import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "End User License Agreement | Brixchat24",
  description: "Brixchat24 end user license agreement.",
};

const sectionStyle = { marginTop: 28 } as const;

export default function TermsPage() {
  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "48px 24px 80px",
        fontFamily: "Arial, sans-serif",
        lineHeight: 1.65,
        color: "#172033",
      }}
    >
      <h1>Brixchat24 End User License Agreement</h1>
      <p>Last updated: August 16, 2026</p>
      <p>
        This End User License Agreement (the &quot;Agreement&quot;) is between
        Hasan Yıldırım, Türkiye (the &quot;Licensor&quot;), and the person or
        organization installing or using Brixchat24 (the &quot;Customer&quot;).
        By installing or using Brixchat24, the Customer accepts this Agreement.
      </p>

      <section style={sectionStyle}>
        <h2>1. Service and license</h2>
        <p>
          Brixchat24 connects supported customer communication channels with
          Bitrix24 CRM and Open Channels. The Licensor grants the Customer a
          limited, non-exclusive, non-transferable and revocable right to use
          Brixchat24 for the Customer&apos;s internal business operations while
          this Agreement remains in effect.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>2. Customer responsibilities</h2>
        <p>
          The Customer is responsible for its Bitrix24, WhatsApp Business and
          Brixchat24 accounts; administrator approvals; authorized users;
          message content; lawful notices and consents; and compliance with the
          terms of Bitrix24, Meta and other connected services. Credentials and
          access tokens must not be shared with unauthorized persons.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>3. Restrictions</h2>
        <p>
          The Customer must not misuse the service, bypass security controls,
          interfere with other customers, distribute malicious content, use the
          service unlawfully, resell access without written permission, or
          attempt to extract source code except where applicable law expressly
          permits it.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>4. Third-party services and charges</h2>
        <p>
          Bitrix24, Meta, WhatsApp Business Platform and other connected
          services are operated by third parties under their own terms. Their
          availability, plan requirements and charges are not controlled by the
          Licensor and remain the Customer&apos;s responsibility.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>5. Data and privacy</h2>
        <p>
          Personal data is handled as described in the Brixchat24 Privacy
          Policy. The Customer remains responsible for the data it submits and
          for providing any legally required privacy notices to its contacts
          and users.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>6. Availability and support</h2>
        <p>
          The Licensor will use reasonable efforts to operate and support the
          service. Maintenance, third-party failures, security incidents or
          events outside reasonable control may interrupt availability. Support
          hours and response targets are published on the Brixchat24 Support
          page and are service targets rather than guaranteed resolution times.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>7. Intellectual property</h2>
        <p>
          Brixchat24 and its original software, branding and documentation
          remain the Licensor&apos;s property. This Agreement grants a right to
          use the service and does not transfer ownership.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>8. Disclaimer and liability</h2>
        <p>
          To the maximum extent permitted by applicable law, the service is
          provided without warranties not expressly stated in this Agreement.
          The Licensor is not liable for indirect, incidental or consequential
          losses, or for failures caused by third-party platforms, unauthorized
          account access or the Customer&apos;s unlawful use. Nothing in this
          section excludes liability that cannot legally be excluded.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>9. Suspension and termination</h2>
        <p>
          The Customer may stop using and uninstall the application at any
          time. The Licensor may suspend or terminate access for material breach,
          unlawful use, security risk or where required by law. Existing CRM
          records in the Customer&apos;s Bitrix24 portal are not deleted merely by
          uninstalling Brixchat24.
        </p>
      </section>

      <section style={sectionStyle}>
        <h2>10. Governing law and contact</h2>
        <p>
          This Agreement is governed by the laws of Türkiye, without prejudice
          to mandatory consumer or data-protection rights that apply to the
          Customer. Questions may be sent to
          {" "}
          <a href="mailto:hsnyldrm-590@hotmail.com">
            hsnyldrm-590@hotmail.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
