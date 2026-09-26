import { randomUUID } from "node:crypto";

export type SectionKind =
  | "testimonials"
  | "pricing"
  | "faq"
  | "features"
  | "cta"
  | "contact"
  | "team"
  | "hero";

export type SectionTemplate = {
  kind: SectionKind;
  label: string;
  description: string;
  generateHtml: (context?: { siteName?: string; primaryColor?: string; phone?: string; email?: string }) => string;
};

export const SECTION_TEMPLATES: Record<SectionKind, SectionTemplate> = {
  testimonials: {
    kind: "testimonials",
    label: "Client Testimonials & Reviews",
    description: "3-column modern customer review grid with star ratings, quotes, and author titles.",
    generateHtml: (ctx) => {
      const id = `sec-testimonials-${randomUUID().slice(0, 6)}`;
      return `
<section id="${id}" class="py-16 md:py-24 bg-slate-50 border-t border-slate-200">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center max-w-2xl mx-auto mb-12">
      <span class="text-xs font-bold uppercase tracking-widest text-blue-600">Client Reviews</span>
      <h2 class="text-3xl md:text-4xl font-extrabold text-slate-900 mt-2 tracking-tight">Trusted by leading companies</h2>
      <p class="text-sm md:text-base text-slate-600 mt-3">See how businesses achieve continuous growth with our proven systems and dedicated delivery.</p>
    </div>
    <div class="grid gap-6 md:grid-cols-3">
      <div class="rounded-2xl bg-white p-6 shadow-sm border border-slate-200 flex flex-col justify-between">
        <div>
          <div class="flex items-center gap-1 text-amber-400 text-sm mb-3">★★★★★</div>
          <p class="text-slate-700 text-sm leading-relaxed italic">"Working with them completely transformed our operational speed. Our new digital platform generated immediate ROI within the very first month."</p>
        </div>
        <div class="mt-6 flex items-center gap-3 pt-4 border-t border-slate-100">
          <div class="h-10 w-10 rounded-full bg-blue-100 text-blue-800 font-bold flex items-center justify-center text-sm">KA</div>
          <div>
            <h4 class="text-sm font-semibold text-slate-900">Kwame Mensah</h4>
            <p class="text-xs text-slate-500">Managing Director · Apex Logistics</p>
          </div>
        </div>
      </div>
      <div class="rounded-2xl bg-white p-6 shadow-sm border border-slate-200 flex flex-col justify-between">
        <div>
          <div class="flex items-center gap-1 text-amber-400 text-sm mb-3">★★★★★</div>
          <p class="text-slate-700 text-sm leading-relaxed italic">"The attention to detail, response times, and engineering execution are unmatched. It feels like having our own world-class in-house technology team."</p>
        </div>
        <div class="mt-6 flex items-center gap-3 pt-4 border-t border-slate-100">
          <div class="h-10 w-10 rounded-full bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center text-sm">AO</div>
          <div>
            <h4 class="text-sm font-semibold text-slate-900">Abena Osei</h4>
            <p class="text-xs text-slate-500">Chief Operating Officer · Goldline Services</p>
          </div>
        </div>
      </div>
      <div class="rounded-2xl bg-white p-6 shadow-sm border border-slate-200 flex flex-col justify-between">
        <div>
          <div class="flex items-center gap-1 text-amber-400 text-sm mb-3">★★★★★</div>
          <p class="text-slate-700 text-sm leading-relaxed italic">"Super clean design and exceptionally reliable performance. Zero downtime and our clients constantly compliment our new modern web experience."</p>
        </div>
        <div class="mt-6 flex items-center gap-3 pt-4 border-t border-slate-100">
          <div class="h-10 w-10 rounded-full bg-purple-100 text-purple-800 font-bold flex items-center justify-center text-sm">EA</div>
          <div>
            <h4 class="text-sm font-semibold text-slate-900">Emmanuel Appiah</h4>
            <p class="text-xs text-slate-500">Founder & CEO · Starlight Media</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
`;
    },
  },

  pricing: {
    kind: "pricing",
    label: "Tiered Pricing Cards",
    description: "3-tier pricing comparison table with highlighted popular plan and feature checklists.",
    generateHtml: (ctx) => {
      const id = `sec-pricing-${randomUUID().slice(0, 6)}`;
      return `
<section id="${id}" class="py-16 md:py-24 bg-white border-t border-slate-200">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center max-w-2xl mx-auto mb-12">
      <span class="text-xs font-bold uppercase tracking-widest text-blue-600">Transparent Pricing</span>
      <h2 class="text-3xl md:text-4xl font-extrabold text-slate-900 mt-2 tracking-tight">Flexible plans designed for growth</h2>
      <p class="text-sm md:text-base text-slate-600 mt-3">Choose the plan that fits your business stage. Upgrade or cancel anytime with zero friction.</p>
    </div>
    <div class="grid gap-6 md:grid-cols-3 items-stretch">
      <div class="rounded-2xl bg-slate-50 p-6 border border-slate-200 flex flex-col justify-between">
        <div>
          <span class="text-xs font-bold text-slate-700 uppercase tracking-wider">Starter</span>
          <div class="mt-3 flex items-baseline gap-1">
            <span class="text-3xl font-extrabold text-slate-900">GHS 2,500</span>
            <span class="text-xs text-slate-500">/month</span>
          </div>
          <p class="text-xs text-slate-600 mt-2">Essential setup and reliable ongoing support for solo entrepreneurs.</p>
          <ul class="mt-6 space-y-2.5 text-xs text-slate-700">
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Fast cloud hosting & SSL</li>
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Mobile responsive layout</li>
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Up to 5 custom pages</li>
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Standard support access</li>
          </ul>
        </div>
        <a href="#contact" class="mt-8 block w-full text-center py-2.5 px-4 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-900 hover:bg-slate-100 transition shadow-xs">Get Started</a>
      </div>
      <div class="rounded-2xl bg-slate-900 p-6 border-2 border-blue-500 text-white flex flex-col justify-between relative shadow-lg">
        <span class="absolute -top-3 right-6 bg-blue-500 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full shadow-xs">Most Popular</span>
        <div>
          <span class="text-xs font-bold text-blue-400 uppercase tracking-wider">Growth Retainer</span>
          <div class="mt-3 flex items-baseline gap-1">
            <span class="text-3xl font-extrabold text-white">GHS 5,000</span>
            <span class="text-xs text-slate-400">/month</span>
          </div>
          <p class="text-xs text-slate-300 mt-2">Accelerated delivery, ongoing enhancements, and proactive optimization.</p>
          <ul class="mt-6 space-y-2.5 text-xs text-slate-300">
            <li class="flex items-center gap-2"><span class="text-blue-400 font-bold">✓</span> Everything in Starter</li>
            <li class="flex items-center gap-2"><span class="text-blue-400 font-bold">✓</span> AI Copy & Layout Assistant</li>
            <li class="flex items-center gap-2"><span class="text-blue-400 font-bold">✓</span> Core Web Vitals speed tuning</li>
            <li class="flex items-center gap-2"><span class="text-blue-400 font-bold">✓</span> Priority turnaround within 24h</li>
            <li class="flex items-center gap-2"><span class="text-blue-400 font-bold">✓</span> Monthly strategy consultation</li>
          </ul>
        </div>
        <a href="#contact" class="mt-8 block w-full text-center py-2.5 px-4 rounded-xl bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500 transition shadow-md">Choose Growth</a>
      </div>
      <div class="rounded-2xl bg-slate-50 p-6 border border-slate-200 flex flex-col justify-between">
        <div>
          <span class="text-xs font-bold text-slate-700 uppercase tracking-wider">Enterprise Concierge</span>
          <div class="mt-3 flex items-baseline gap-1">
            <span class="text-3xl font-extrabold text-slate-900">Custom</span>
          </div>
          <p class="text-xs text-slate-600 mt-2">Custom web architecture, high-volume platforms, and direct founder access.</p>
          <ul class="mt-6 space-y-2.5 text-xs text-slate-700">
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Everything in Growth</li>
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Custom integrations & APIs</li>
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Dedicated engineering lead</li>
            <li class="flex items-center gap-2"><span class="text-emerald-500 font-bold">✓</span> Guaranteed SLA uptime</li>
          </ul>
        </div>
        <a href="#contact" class="mt-8 block w-full text-center py-2.5 px-4 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-900 hover:bg-slate-100 transition shadow-xs">Contact Founder</a>
      </div>
    </div>
  </div>
</section>
`;
    },
  },

  faq: {
    kind: "faq",
    label: "FAQ Accordion Questions",
    description: "4-item clean accordion questions & answers.",
    generateHtml: (ctx) => {
      const id = `sec-faq-${randomUUID().slice(0, 6)}`;
      return `
<section id="${id}" class="py-16 md:py-24 bg-slate-50 border-t border-slate-200">
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center max-w-2xl mx-auto mb-12">
      <span class="text-xs font-bold uppercase tracking-widest text-blue-600">Frequently Asked Questions</span>
      <h2 class="text-3xl md:text-4xl font-extrabold text-slate-900 mt-2 tracking-tight">Everything you need to know</h2>
      <p class="text-sm md:text-base text-slate-600 mt-3">Find clear answers to common questions about our delivery, process, and ongoing support.</p>
    </div>
    <div class="space-y-4">
      <details class="group rounded-2xl bg-white p-5 border border-slate-200 cursor-pointer transition">
        <summary class="flex items-center justify-between font-semibold text-slate-900 text-sm list-none select-none">
          <span>How fast can our new website be launched?</span>
          <span class="transition group-open:rotate-180 text-slate-400">▼</span>
        </summary>
        <p class="mt-3 text-xs md:text-sm text-slate-600 leading-relaxed">Most business websites launch within 7 to 14 working days. If you choose our pre-designed templates or import an existing site, delivery is usually even faster.</p>
      </details>
      <details class="group rounded-2xl bg-white p-5 border border-slate-200 cursor-pointer transition">
        <summary class="flex items-center justify-between font-semibold text-slate-900 text-sm list-none select-none">
          <span>Can I easily edit text and images myself?</span>
          <span class="transition group-open:rotate-180 text-slate-400">▼</span>
        </summary>
        <p class="mt-3 text-xs md:text-sm text-slate-600 leading-relaxed">Yes. You get full access to our visual editor and AI assistant where you can click any heading, paragraph, or image to update it with zero technical knowledge required.</p>
      </details>
      <details class="group rounded-2xl bg-white p-5 border border-slate-200 cursor-pointer transition">
        <summary class="flex items-center justify-between font-semibold text-slate-900 text-sm list-none select-none">
          <span>What payment methods do you support?</span>
          <span class="transition group-open:rotate-180 text-slate-400">▼</span>
        </summary>
        <p class="mt-3 text-xs md:text-sm text-slate-600 leading-relaxed">We accept MTN Mobile Money, Telecel Cash, Visa, Mastercard, and direct bank transfers. Invoices are paid securely through Paystack.</p>
      </details>
      <details class="group rounded-2xl bg-white p-5 border border-slate-200 cursor-pointer transition">
        <summary class="flex items-center justify-between font-semibold text-slate-900 text-sm list-none select-none">
          <span>Is search engine optimization (SEO) included?</span>
          <span class="transition group-open:rotate-180 text-slate-400">▼</span>
        </summary>
        <p class="mt-3 text-xs md:text-sm text-slate-600 leading-relaxed">Yes. Every page comes pre-configured with semantic HTML, automated OpenGraph social share cards, meta descriptions, fast Core Web Vitals caching, and mobile-first responsiveness.</p>
      </details>
    </div>
  </div>
</section>
`;
    },
  },

  features: {
    kind: "features",
    label: "Features & Value Propositions",
    description: "3-column feature grid with modern icon badges and benefit descriptions.",
    generateHtml: (ctx) => {
      const id = `sec-features-${randomUUID().slice(0, 6)}`;
      return `
<section id="${id}" class="py-16 md:py-24 bg-white border-t border-slate-200">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center max-w-2xl mx-auto mb-12">
      <span class="text-xs font-bold uppercase tracking-widest text-blue-600">Core Advantages</span>
      <h2 class="text-3xl md:text-4xl font-extrabold text-slate-900 mt-2 tracking-tight">Engineered for maximum reliability</h2>
      <p class="text-sm md:text-base text-slate-600 mt-3">Everything your company needs to operate seamlessly without hiring a bloated internal team.</p>
    </div>
    <div class="grid gap-8 md:grid-cols-3">
      <div class="rounded-2xl border border-slate-200 bg-slate-50/50 p-6">
        <div class="h-10 w-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-lg mb-4">⚡</div>
        <h3 class="text-lg font-bold text-slate-900">Blazing Fast Speed</h3>
        <p class="mt-2 text-xs md:text-sm text-slate-600 leading-relaxed">Global CDN caching and sub-second page loads ensure your visitors convert instead of bouncing away.</p>
      </div>
      <div class="rounded-2xl border border-slate-200 bg-slate-50/50 p-6">
        <div class="h-10 w-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center font-bold text-lg mb-4">🛡️</div>
        <h3 class="text-lg font-bold text-slate-900">Bank-Grade Security</h3>
        <p class="mt-2 text-xs md:text-sm text-slate-600 leading-relaxed">Automated daily backups, SSL encryption, and continuous monitoring to guard your brand reputation.</p>
      </div>
      <div class="rounded-2xl border border-slate-200 bg-slate-50/50 p-6">
        <div class="h-10 w-10 rounded-xl bg-purple-100 text-purple-600 flex items-center justify-center font-bold text-lg mb-4">🤖</div>
        <h3 class="text-lg font-bold text-slate-900">AI-Powered Updates</h3>
        <p class="mt-2 text-xs md:text-sm text-slate-600 leading-relaxed">Generate marketing copy, translate languages, and re-theme your pages with conversational intelligence.</p>
      </div>
    </div>
  </div>
</section>
`;
    },
  },

  cta: {
    kind: "cta",
    label: "Call to Action Banner",
    description: "High-contrast action banner with headline, subheadline, and primary button.",
    generateHtml: (ctx) => {
      const id = `sec-cta-${randomUUID().slice(0, 6)}`;
      return `
<section id="${id}" class="py-16 md:py-20 bg-slate-900 text-white">
  <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
    <h2 class="text-3xl md:text-4xl font-extrabold tracking-tight">Ready to elevate your digital presence?</h2>
    <p class="mt-3 text-sm md:text-base text-slate-300 max-w-2xl mx-auto">Get in touch today for a direct consultation. Let us build and manage the high-performing digital systems your business deserves.</p>
    <div class="mt-8 flex flex-wrap justify-center gap-4">
      <a href="#contact" class="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-white text-slate-900 text-xs md:text-sm font-bold shadow-md hover:bg-slate-100 transition">Get Started Today →</a>
      <a href="tel:${ctx?.phone || "+233200000000"}" class="inline-flex items-center justify-center px-6 py-3 rounded-xl border border-slate-700 bg-slate-800/80 text-white text-xs md:text-sm font-semibold hover:bg-slate-800 transition">Call Founder Directly</a>
    </div>
  </div>
</section>
`;
    },
  },

  contact: {
    kind: "contact",
    label: "Direct Contact & Details",
    description: "Contact cards with telephone, email, WhatsApp, and office hours.",
    generateHtml: (ctx) => {
      const id = `sec-contact-${randomUUID().slice(0, 6)}`;
      const phone = ctx?.phone || "+233 20 000 0000";
      const email = ctx?.email || "hello@dakyworld.com";
      return `
<section id="${id}" class="py-16 md:py-24 bg-white border-t border-slate-200">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center max-w-2xl mx-auto mb-12">
      <span class="text-xs font-bold uppercase tracking-widest text-blue-600">Get In Touch</span>
      <h2 class="text-3xl md:text-4xl font-extrabold text-slate-900 mt-2 tracking-tight">Speak with our team</h2>
      <p class="text-sm md:text-base text-slate-600 mt-3">We are available Monday to Friday, 8:00 AM – 6:00 PM GMT.</p>
    </div>
    <div class="grid gap-6 md:grid-cols-3">
      <a href="tel:${phone.replace(/\s+/g, "")}" class="rounded-2xl border border-slate-200 bg-slate-50/60 p-6 block hover:border-slate-400 transition">
        <span class="text-2xl mb-3 block">📞</span>
        <h3 class="text-sm font-bold text-slate-900">Telephone</h3>
        <p class="text-xs text-slate-600 mt-1">${phone}</p>
        <span class="text-xs font-semibold text-blue-600 mt-4 block">Call now →</span>
      </a>
      <a href="mailto:${email}" class="rounded-2xl border border-slate-200 bg-slate-50/60 p-6 block hover:border-slate-400 transition">
        <span class="text-2xl mb-3 block">✉️</span>
        <h3 class="text-sm font-bold text-slate-900">Email Address</h3>
        <p class="text-xs text-slate-600 mt-1">${email}</p>
        <span class="text-xs font-semibold text-blue-600 mt-4 block">Send message →</span>
      </a>
      <a href="https://wa.me/${phone.replace(/[^0-9]/g, "")}" target="_blank" rel="noreferrer" class="rounded-2xl border border-slate-200 bg-slate-50/60 p-6 block hover:border-slate-400 transition">
        <span class="text-2xl mb-3 block">💬</span>
        <h3 class="text-sm font-bold text-slate-900">WhatsApp Chat</h3>
        <p class="text-xs text-slate-600 mt-1">Instant messaging & support</p>
        <span class="text-xs font-semibold text-emerald-600 mt-4 block">Chat on WhatsApp →</span>
      </a>
    </div>
  </div>
</section>
`;
    },
  },

  team: {
    kind: "team",
    label: "Team Leadership Showcase",
    description: "3-member team profile cards with names, titles, and bio snippets.",
    generateHtml: (ctx) => {
      const id = `sec-team-${randomUUID().slice(0, 6)}`;
      return `
<section id="${id}" class="py-16 md:py-24 bg-slate-50 border-t border-slate-200">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="text-center max-w-2xl mx-auto mb-12">
      <span class="text-xs font-bold uppercase tracking-widest text-blue-600">Our Leadership</span>
      <h2 class="text-3xl md:text-4xl font-extrabold text-slate-900 mt-2 tracking-tight">The people behind the work</h2>
      <p class="text-sm md:text-base text-slate-600 mt-3">Experienced technologists, designers, and systems architects dedicated to your brand.</p>
    </div>
    <div class="grid gap-6 md:grid-cols-3">
      <div class="rounded-2xl bg-white border border-slate-200 p-6 text-center shadow-xs">
        <div class="h-20 w-20 rounded-full bg-slate-200 mx-auto font-bold text-slate-600 flex items-center justify-center text-xl mb-4">DA</div>
        <h3 class="text-base font-bold text-slate-900">Dan Kwame Ayipah</h3>
        <p class="text-xs text-blue-600 font-semibold mt-0.5">Founder & Lead Architect</p>
        <p class="text-xs text-slate-600 mt-3 leading-relaxed">5+ years engineering high-availability platforms, security automations, and digital growth infrastructure across West Africa.</p>
      </div>
      <div class="rounded-2xl bg-white border border-slate-200 p-6 text-center shadow-xs">
        <div class="h-20 w-20 rounded-full bg-slate-200 mx-auto font-bold text-slate-600 flex items-center justify-center text-xl mb-4">KO</div>
        <h3 class="text-base font-bold text-slate-900">Kofi Owusu</h3>
        <p class="text-xs text-blue-600 font-semibold mt-0.5">Senior Web Engineer</p>
        <p class="text-xs text-slate-600 mt-3 leading-relaxed">Specialist in performant frontend interfaces, responsive styling, and modern accessibility standards.</p>
      </div>
      <div class="rounded-2xl bg-white border border-slate-200 p-6 text-center shadow-xs">
        <div class="h-20 w-20 rounded-full bg-slate-200 mx-auto font-bold text-slate-600 flex items-center justify-center text-xl mb-4">SA</div>
        <h3 class="text-base font-bold text-slate-900">Sarah Arthur</h3>
        <p class="text-xs text-blue-600 font-semibold mt-0.5">Product & Client Operations</p>
        <p class="text-xs text-slate-600 mt-3 leading-relaxed">Ensuring smooth delivery schedules, seamless client onboarding, and proactive retainer care.</p>
      </div>
    </div>
  </div>
</section>
`;
    },
  },

  hero: {
    kind: "hero",
    label: "Modern Hero Banner",
    description: "High-impact hero with headline, subheadline, dual action buttons, and trust metrics.",
    generateHtml: (ctx) => {
      const id = `sec-hero-${randomUUID().slice(0, 6)}`;
      const name = ctx?.siteName || "Your Company";
      return `
<section id="${id}" class="py-20 md:py-32 bg-slate-900 text-white relative overflow-hidden">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-6 border border-blue-500/30">Next-Generation Platform</span>
    <h1 class="text-4xl md:text-6xl font-extrabold tracking-tight leading-tight max-w-4xl mx-auto">Build, scale, and dominate your market with ${name}</h1>
    <p class="mt-5 text-base md:text-lg text-slate-300 max-w-2xl mx-auto leading-relaxed">We deliver high-impact digital systems, beautiful web architecture, and continuous technical reliability.</p>
    <div class="mt-8 flex flex-wrap justify-center gap-4">
      <a href="#contact" class="px-6 py-3 rounded-xl bg-blue-600 text-white text-xs md:text-sm font-bold shadow-lg hover:bg-blue-500 transition">Explore Solutions →</a>
      <a href="#about" class="px-6 py-3 rounded-xl border border-slate-700 bg-slate-800 text-slate-200 text-xs md:text-sm font-semibold hover:bg-slate-700 transition">Learn More</a>
    </div>
  </div>
</section>
`;
    },
  },
};

/**
 * Inserts a section into HTML before the footer, before closing main, or before closing body.
 */
export function injectSectionIntoHtml(html: string, sectionHtml: string): string {
  // 1. Try before <footer>
  if (/<footer\b/i.test(html)) {
    return html.replace(/<footer\b/i, `${sectionHtml.trim()}\n<footer`);
  }
  // 2. Try before </main>
  if (/<\/main>/i.test(html)) {
    return html.replace(/<\/main>/i, `${sectionHtml.trim()}\n</main>`);
  }
  // 3. Try before </body>
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${sectionHtml.trim()}\n</body>`);
  }
  // 4. Fallback append
  return `${html.trim()}\n${sectionHtml.trim()}`;
}
