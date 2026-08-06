import { describe, expect, it } from 'vitest'
import { scoreClaim, type ClaimForScoring, type ScoringEvidence } from '../src/core/confidence.js'

function ev(partial: Partial<ScoringEvidence>): ScoringEvidence {
  return {
    evidenceId: partial.evidenceId ?? 'ev_x',
    stance: 'supports',
    directness: 'direct',
    extractorConfidence: 0.9,
    quote: '限定角色抽卡保底为80抽',
    sourceId: 'src_a',
    sourceType: 'official',
    ownerKey: 'mihoyo.com',
    authorityPrior: 0.9,
    dupCluster: null,
    suspectedPromo: false,
    publishedAt: new Date().toISOString(),
    versionTag: null,
    ...partial,
  }
}

const factClaim: ClaimForScoring = {
  claimType: 'official_fact',
  valueJson: { value: 80, unit: '抽' },
  versionMin: null,
  versionMax: null,
  hasOpenConflict: false,
  premiseConfidences: [],
}

describe('confidence engine — honesty rules', () => {
  it('returns insufficient with NULL confidence when there is no evidence', () => {
    const r = scoreClaim(factClaim, [])
    expect(r.band).toBe('insufficient')
    expect(r.confidence).toBeNull()
  })

  it('mentions-only evidence is not admissible', () => {
    const r = scoreClaim(factClaim, [ev({ stance: 'mentions' })])
    expect(r.band).toBe('insufficient')
    expect(r.confidence).toBeNull()
  })

  it('caps single-source claims at 0.70 and never marks them verified', () => {
    const r = scoreClaim(factClaim, [ev({})])
    expect(r.confidence).not.toBeNull()
    expect(r.confidence!).toBeLessThanOrEqual(0.7)
    expect(r.band).not.toBe('verified')
    expect(r.breakdown.caps.map((c) => c.rule)).toContain('single_source_cap')
  })

  it('verifies claims with multiple independent high-authority sources', () => {
    const r = scoreClaim(factClaim, [
      ev({ evidenceId: 'e1', ownerKey: 'mihoyo.com', quote: '保底为80抽' }),
      ev({ evidenceId: 'e2', ownerKey: 'apple.com/appstore', sourceType: 'store_metadata', authorityPrior: 0.85, quote: '80抽保底机制' }),
      ev({ evidenceId: 'e3', ownerKey: 'youxiputao.com', sourceType: 'press', authorityPrior: 0.7, quote: '保底次数为80' }),
    ])
    expect(r.band).toBe('verified')
    expect(r.confidence!).toBeGreaterThanOrEqual(0.85)
  })

  it('collapses syndicated copies into one independent source (no fake triangulation)', () => {
    const r = scoreClaim(factClaim, [
      ev({ evidenceId: 'e1', ownerKey: 'site-a.com', dupCluster: 'cluster1' }),
      ev({ evidenceId: 'e2', ownerKey: 'site-b.com', dupCluster: 'cluster1' }),
      ev({ evidenceId: 'e3', ownerKey: 'site-c.com', dupCluster: 'cluster1' }),
    ])
    expect(r.breakdown.caps.map((c) => c.rule)).toContain('single_source_cap')
    expect(r.confidence!).toBeLessThanOrEqual(0.7)
  })

  it('marks claims with open conflicts as disputed regardless of score', () => {
    const r = scoreClaim({ ...factClaim, hasOpenConflict: true }, [
      ev({ evidenceId: 'e1', ownerKey: 'a.com' }),
      ev({ evidenceId: 'e2', ownerKey: 'b.com' }),
    ])
    expect(r.band).toBe('disputed')
  })

  it('refuting evidence lowers confidence', () => {
    const base = scoreClaim(factClaim, [ev({ evidenceId: 'e1' }), ev({ evidenceId: 'e2', ownerKey: 'other.com' })])
    const refuted = scoreClaim(factClaim, [
      ev({ evidenceId: 'e1' }),
      ev({ evidenceId: 'e2', ownerKey: 'other.com' }),
      ev({ evidenceId: 'e3', stance: 'refutes', ownerKey: 'refuter.com' }),
    ])
    expect(refuted.confidence!).toBeLessThan(base.confidence!)
  })

  it('marketing-suspect sources drag confidence down', () => {
    const clean = scoreClaim(factClaim, [ev({ evidenceId: 'e1' }), ev({ evidenceId: 'e2', ownerKey: 'b.com' })])
    const promo = scoreClaim(factClaim, [
      ev({ evidenceId: 'e1', suspectedPromo: true }),
      ev({ evidenceId: 'e2', ownerKey: 'b.com', suspectedPromo: true }),
    ])
    expect(promo.confidence!).toBeLessThan(clean.confidence!)
  })

  it('creative insights are capped below verified', () => {
    const r = scoreClaim(
      { ...factClaim, claimType: 'creative_insight', premiseConfidences: [0.9, 0.95] },
      [ev({ evidenceId: 'e1', directness: 'interpretive' }), ev({ evidenceId: 'e2', ownerKey: 'b.com', directness: 'interpretive' })],
    )
    expect(r.band).not.toBe('verified')
    expect(r.confidence!).toBeLessThanOrEqual(0.75)
  })
})

describe('confidence engine — opinion representativeness (separate axis from truth)', () => {
  const opinion = (holding: number, total: number, platforms = 2): ClaimForScoring => ({
    claimType: 'player_opinion',
    valueJson: null,
    versionMin: null,
    versionMax: null,
    hasOpenConflict: false,
    premiseConfidences: [],
    opinionSample: { holding, total, independentPlatforms: platforms },
  })

  it('small samples stay uncertain even at 100% agreement (Wilson shrinkage)', () => {
    const r = scoreClaim(opinion(5, 5), [ev({ stance: 'supports', quote: '太肝了' })])
    expect(r.band).toBe('uncertain')
  })

  it('large consistent samples across platforms can be verified-representative', () => {
    const r = scoreClaim(opinion(70, 150, 2), [ev({ stance: 'supports', quote: '太肝了' })])
    expect(r.band).toBe('verified')
    expect(r.breakdown.note).toContain('代表性')
  })

  it('helpful votes never appear as a scoring factor', () => {
    const r = scoreClaim(opinion(40, 100), [ev({ stance: 'supports' })])
    const factorNames = r.breakdown.factors.map((f) => f.factor)
    expect(factorNames).not.toContain('helpful_votes')
    expect(factorNames).not.toContain('engagement')
  })
})
