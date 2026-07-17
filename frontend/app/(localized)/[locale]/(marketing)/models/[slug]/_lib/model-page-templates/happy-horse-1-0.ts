import type { ModelPageTemplateConfig } from '../model-page-template-types';

export const happyHorse10TemplateConfig: ModelPageTemplateConfig = {
  slug: 'happy-horse-1-0',
  intent: 'production',
  hero: {
    eyebrow: 'ALIBABA LEGACY VIDEO EDIT ROUTE',
    subtitleHighlightTerms: ['legacy video edit', 'native audio', 'Happy Horse 1.1'],
    primaryCtaHref: '/app?engine=happy-horse-1-0',
    secondaryCtaHref: '/examples/happy-horse',
    quickLinks: [
      {
        labelKey: 'compareSeedance',
        href: '/ai-video-engines/happy-horse-1-1-vs-happy-horse-1-0',
        icon: 'compare',
      },
      {
        labelKey: 'viewPricing',
        href: '/pricing#happy-horse-1-0-pricing',
        icon: 'pricing',
      },
      {
        labelKey: 'promptExamples',
        href: '#prompting',
        icon: 'prompt',
      },
    ],
  },
  pricing: {
    anchorHref: '/pricing#happy-horse-1-0-pricing',
    presets: [
      { id: '5s-720p-audio', seconds: 5, resolution: '720p', audio: true, labelKey: 'nativeAudioWorkflow' },
      { id: '10s-720p-audio', seconds: 10, resolution: '720p', audio: true, labelKey: 'commonProductionCheck' },
      {
        id: '15s-1080p-audio',
        seconds: 15,
        resolution: '1080p',
        audio: true,
        labelKey: 'finalDelivery',
        highlightKey: 'mostPopular',
      },
      { id: 'max-duration', fixedValueKey: 'maxDurationValue', labelKey: 'maxDuration', noteKey: 'upTo1080p' },
    ],
  },
  sections: {
    examples: true,
    prompting: true,
    tips: true,
    compare: true,
    specs: true,
    safety: true,
    faq: true,
  },
};
