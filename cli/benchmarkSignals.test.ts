import { describe, expect, it } from 'vitest';
import { classifyStrategyLabels, findMatchedTerms, getDefaultBenchmarkSearchTerms } from './benchmarkSignals.js';

describe('findMatchedTerms', () => {
  it('matches contextual cycle fix phrases that are more specific than the default term list', () => {
    const searchTerms = getDefaultBenchmarkSearchTerms();

    expect(findMatchedTerms('fix(ui): break app chat settings cycle', searchTerms)).toEqual(
      expect.arrayContaining(['break cycle']),
    );
    expect(findMatchedTerms('Nostr: remove plugin API import cycle', searchTerms)).toEqual(
      expect.arrayContaining(['import cycle']),
    );
    expect(findMatchedTerms('fix: break Synology Chat plugin-sdk reexport cycle', searchTerms)).toEqual(
      expect.arrayContaining(['export cycle', 'break cycle', 'reexport']),
    );
    expect(
      findMatchedTerms('Plugins: fix signal SDK circular re-exports and reserved commands TDZ', searchTerms),
    ).toEqual(expect.arrayContaining(['circular', 're-export']));
  });

  it('does not treat lifecycle-only messages as cycle fixes', () => {
    const searchTerms = getDefaultBenchmarkSearchTerms();
    expect(findMatchedTerms('Add session lifecycle gateway methods', searchTerms)).toEqual([]);
  });
});

describe('classifyStrategyLabels', () => {
  it('adds public seam and export-graph labels when plugin-sdk or api seams change', () => {
    expect(
      classifyStrategyLabels('Nostr: remove plugin API import cycle', [
        'extensions/nostr/src/channel.ts',
        'src/plugin-sdk/nostr.ts',
      ]),
    ).toEqual(expect.arrayContaining(['public_seam_bypass', 'export_graph_rewrite']));
  });

  it('adds ownership-localization labels for caller-owned settings cycle fixes', () => {
    expect(
      classifyStrategyLabels('fix(ui): break app chat settings cycle', [
        'ui/src/ui/app-chat.ts',
        'ui/src/ui/app-chat.test.ts',
      ]),
    ).toEqual(expect.arrayContaining(['ownership_localization', 'host_owned_state_update']));
  });

  it('adds internal-surface labels when internalized surfaces are introduced', () => {
    expect(
      classifyStrategyLabels('Plugins: internalize line SDK imports', [
        'src/plugin-sdk-internal/discord.ts',
        'extensions/discord/src/accounts.ts',
      ]),
    ).toEqual(expect.arrayContaining(['internal_surface_split']));
  });
});
