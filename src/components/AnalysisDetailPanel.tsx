import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { BROADBAND_TECH_LABELS, broadbandSeverity, formatBroadbandSpeed } from '../map/broadband'
import { type CommuteEstimate, type WorkAddress, commuteSeverity, formatCommuteMinutes } from '../map/commute'
import { CROWD_ANALYSIS_RADIUS_MI, CROWD_COLORS, CROWD_ICONS, CROWD_LABEL_SINGULAR } from '../map/crowd'
import { DATA_CENTER_ANALYSIS_RADIUS_MI, DC_STATUSES, DC_STATUS_COLORS, DC_STATUS_LABELS } from '../map/datacenters'
import { FLOOD_ZONE_COLORS, FLOOD_ZONE_LABELS, floodSeverity } from '../map/flood'
import { RAILROAD_ANALYSIS_RADIUS_MI } from '../map/railroad'
import { costcoSeverity, erSeverity, computeLocationGrade } from '../map/scoring'
import { seismicSeverity } from '../map/seismic'
import { tornadoSeverity } from '../map/tornado'
import { wildfireSeverity } from '../map/wildfire'
import { COSTCO_ANALYSIS_RADIUS_MI, ER_ANALYSIS_RADIUS_MI, SUPERFUND_ANALYSIS_RADIUS_MI } from '../map/analysisConfig'
import { NPL_STATUS_INFO } from '../map/analysisPresentation'
import type { AnalysisDetail, AnalysisResults } from '../map/analysisTypes'

const GRADE_DESCRIPTIONS: Record<string, string> = {
  A: 'This location has minimal environmental or infrastructure concerns. All categories show favorable conditions, making it well-suited for residential or commercial use without significant risk factors.',
  B: 'This location is generally favorable with only minor concerns in one or two categories. Any flagged issues are moderate and unlikely to significantly impact quality of life or property value.',
  C: 'This location has a mix of favorable and concerning factors. One or more categories show moderate issues that warrant further investigation before making a decision.',
  D: 'This location has notable concerns across multiple categories. Several environmental or infrastructure factors may negatively affect quality of life, property value, or health.',
  F: 'This location has significant concerns across most categories. Multiple high-severity issues were detected that could substantially impact livability, safety, or long-term value.',
}

const SCORE_EXPLANATIONS: Record<string, Record<'clear' | 'warning' | 'danger', string>> = {
  'Airport Noise': {
    clear: 'This location is outside all mapped airport noise contours, meaning aircraft noise is unlikely to be a concern.',
    warning: 'This location falls within a moderate airport noise contour. You may notice aircraft during peak hours, but it is generally manageable for most residents.',
    danger: 'This location is within a high noise zone (65+ dB DNL). Expect frequent, noticeable aircraft noise that may affect outdoor activities and sleep quality.',
  },
  'Superfund Sites': {
    clear: `No EPA Superfund sites were found within ${SUPERFUND_ANALYSIS_RADIUS_MI} miles. This area is clear of known hazardous waste cleanup activity.`,
    warning: 'A small number of Superfund sites are nearby. Residual risk may be limited, but due diligence is recommended.',
    danger: `One or more active Superfund sites are within ${SUPERFUND_ANALYSIS_RADIUS_MI} miles. Active sites may pose environmental or health risks and could affect property values.`,
  },
  'Emergency Room': {
    clear: 'An emergency room is within close range. Quick access to emergency medical care is a significant safety advantage for this location.',
    warning: 'An emergency room is at moderate distance. Response times may be longer during peak traffic, but access is still reasonable.',
    danger: 'No emergency room was found nearby. Longer travel times to emergency care could be a concern, especially for families or elderly residents.',
  },
  'Data Centers': {
    clear: 'No data centers were detected nearby. This area is clear of associated concerns like noise from cooling systems or heavy truck traffic.',
    warning: 'A few data centers are nearby. Minor impacts from generator testing, backup diesel operations, or increased traffic are possible.',
    danger: 'Multiple data centers are near this location. Expect potential noise from industrial cooling, periodic generator testing, and increased commercial vehicle traffic.',
  },
  'Crowd Magnets': {
    clear: `No major venues, stadiums, or arenas were found within ${CROWD_ANALYSIS_RADIUS_MI} miles. Expect normal traffic patterns without event-driven surges.`,
    warning: 'A nearby venue or attraction may bring seasonal traffic, event-night congestion, or noise during peak hours.',
    danger: 'Multiple high-draw venues are close by. Expect significant event-driven traffic, parking pressure, and noise on game days, concert nights, or convention weekends.',
  },
  Broadband: {
    clear: 'Multiple providers offer high-speed (100+ Mbps) or gigabit service at this address. You should have plenty of options for fast, reliable internet.',
    warning: 'Broadband is available but speeds are modest. Streaming and video calls work, but heavy households or remote workers may feel constrained.',
    danger: 'This address is FCC-underserved (<25 Mbps down). Expect very limited wired options — consider fixed wireless, satellite, or cellular as alternatives.',
  },
  'Nearest Costco': {
    clear: 'A Costco is within reasonable range. You magnificent, bulk-buying genius — rotisserie chickens practically deliver themselves at this distance.',
    warning: 'A Costco is within reasonable range. You magnificent, bulk-buying genius — rotisserie chickens practically deliver themselves at this distance.',
    danger: 'No Costco in sight. You\'ll be buying toilet paper like a regular person — one sad, normal-sized pack at a time. Our condolences.',
  },
  'Flood Zone': {
    clear: 'This address is outside FEMA\'s moderate- and high-risk flood zones. Flood insurance is generally not federally required, though no area is completely risk-free.',
    warning: 'This address is in a moderate-risk zone (0.2% annual-chance / "500-year" floodplain). Flood insurance is usually optional but recommended — moderate-risk areas still see a meaningful share of claims.',
    danger: 'This address is in a Special Flood Hazard Area (1% annual-chance / "100-year" floodplain) or coastal V zone. Federally backed mortgages require flood insurance, premiums run higher, and flood risk is real.',
  },
  'Wildfire Hazard': {
    clear: 'This address is in a Low / Very Low USFS wildfire hazard class (or a non-burnable developed/water area). Wildfire risk here is minimal, though no area is entirely risk-free.',
    warning: 'This address is in a Moderate wildfire hazard class. Risk is real but lower — defensible space and ember-resistant home hardening are still worthwhile precautions.',
    danger: 'This address is in a High or Very High wildfire hazard class. Expect stricter insurance underwriting and higher premiums, defensible-space obligations, and meaningful wildfire risk in fire season.',
  },
  Railroad: {
    clear: 'No active railroad track was found within a quarter mile. Train-horn noise and vibration are unlikely to be a concern at this location.',
    warning: 'An active railroad track runs within a quarter mile. Expect possible train-horn noise, vibration, and overnight freight movements — visit the property at different times of day before deciding.',
    danger: 'An active railroad track runs within a quarter mile. Expect possible train-horn noise, vibration, and overnight freight movements — visit the property at different times of day before deciding.',
  },
}

interface AnalysisDetailPanelProps {
  analysisDetail: AnalysisDetail
  analysisResults: AnalysisResults
  address: string
  workAddress: WorkAddress | null
  workAddressEditing: boolean
  workAddressDraft: string
  workAddressSaving: boolean
  workAddressInputError: string | null
  commuteLoading: boolean
  commuteResult: CommuteEstimate | null
  setAnalysisDetail: Dispatch<SetStateAction<AnalysisDetail>>
  setShowScoreBreakdown: Dispatch<SetStateAction<boolean>>
  setWorkAddressDraft: Dispatch<SetStateAction<string>>
  setWorkAddressInputError: Dispatch<SetStateAction<string | null>>
  setWorkAddressEditing: Dispatch<SetStateAction<boolean>>
  submitWorkAddress: () => void
  removeWorkAddress: () => void
  retryCostco: () => void
}

export default function AnalysisDetailPanel({
  analysisDetail,
  analysisResults,
  address,
  workAddress,
  workAddressEditing,
  workAddressDraft,
  workAddressSaving,
  workAddressInputError,
  commuteLoading,
  commuteResult,
  setAnalysisDetail,
  setShowScoreBreakdown,
  setWorkAddressDraft,
  setWorkAddressInputError,
  setWorkAddressEditing,
  submitWorkAddress,
  removeWorkAddress,
  retryCostco,
}: AnalysisDetailPanelProps) {
  return (
    <>
      {analysisDetail && !analysisResults.loading && (
        <aside className="analysis-popout" role="dialog" aria-modal="false" aria-label="Analysis detail">
          <div className="analysis-popout-header">
            <strong>
              {analysisDetail === 'score' ? '📊 Score Breakdown' :
               analysisDetail === 'noise' ? '✈️ Airport Noise' :
               analysisDetail === 'superfunds' ? '☢️ Superfund Sites' :
               analysisDetail === 'costco' ? '🛒 Nearest Costco' :
               analysisDetail === 'er' ? '🏥 Emergency Room' :
               analysisDetail === 'crowd' ? '🎟️ Crowd Magnets' :
               analysisDetail === 'railroad' ? '🚂 Railroad Proximity' :
               analysisDetail === 'broadband' ? '📶 Broadband at this Address' :
               analysisDetail === 'flood' ? '🌊 Flood Zone' :
               analysisDetail === 'wildfire' ? '🔥 Wildfire Hazard' :
               analysisDetail === 'seismic' ? '🌎 Seismic Hazard' :
               analysisDetail === 'tornado' ? '🌪️ Tornado Risk' :
               analysisDetail === 'commute' ? '🚗 Commute Time' :
               '🏢 Data Centers'}
            </strong>
            <button className="analysis-popout-close" onClick={() => {
              const wasScore = analysisDetail === 'score'
              setAnalysisDetail(null)
              if (wasScore) setShowScoreBreakdown(false)
            }} aria-label="Close detail">×</button>
          </div>
          <div className="analysis-popout-body">
            {analysisDetail === 'score' && (() => {
              const grade = computeLocationGrade(analysisResults)
              const severityOf = (b: (typeof grade.breakdown)[number]): 'clear' | 'warning' | 'danger' => {
                const ratio = b.max > 0 ? b.score / b.max : 0
                return b.score === 0 ? 'clear' : ratio >= 0.9 ? 'danger' : 'warning'
              }
              // Sort rows worst-first by severity color: red (danger) →
              // yellow (warning) → green (clear). Array.sort is stable, so
              // rows sharing a severity keep their canonical tier order.
              const severityRank: Record<'clear' | 'warning' | 'danger', number> = { danger: 0, warning: 1, clear: 2 }
              const sortedBreakdown = [...grade.breakdown].sort(
                (a, b) => severityRank[severityOf(a)] - severityRank[severityOf(b)],
              )
              return (
                <>
                  <div className="score-breakdown-grade-summary">
                    <div className="score-breakdown-grade-badge" style={{ '--grade-color': grade.color } as CSSProperties}>{grade.letter}</div>
                    <div className="score-breakdown-grade-info">
                      <strong>{Math.round(grade.pct * 100)}% — {grade.letter === 'A' ? 'Excellent' : grade.letter === 'B' ? 'Good' : grade.letter === 'C' ? 'Fair' : grade.letter === 'D' ? 'Poor' : 'Critical'}</strong>
                      <p>{GRADE_DESCRIPTIONS[grade.letter]}</p>
                    </div>
                  </div>
                  <div className="score-breakdown-divider" />
                  {sortedBreakdown.map((b) => {
                    // Severity is derived from the score/max ratio so the
                    // visual stays correct regardless of which tier weight
                    // (1, 2, or 3) the row uses.
                    const sevKey = severityOf(b)
                    const barColor = sevKey === 'clear' ? '#4caf50' : sevKey === 'warning' ? '#ffb300' : '#ef5350'
                    const statusLabel = sevKey === 'clear' ? 'No concerns' : sevKey === 'warning' ? 'Minor concern' : 'Notable concern'
                    const tierLabel = b.tier === 'safety' ? 'Safety' : b.tier === 'lifestyle' ? 'Lifestyle' : 'Convenience'
                    return (
                      <div className="score-breakdown-row" key={b.label}>
                        <div className="score-breakdown-label">
                          <span>{b.icon}</span>
                          <span>{b.label}</span>
                          <span className="score-breakdown-tier" title={`${tierLabel} tier · ${b.max === 1 ? 'sole factor in its tier' : `weight ${b.max} within the ${tierLabel} tier`}`}>{tierLabel}</span>
                          <span className="score-breakdown-status" style={{ color: barColor }}>{statusLabel}</span>
                        </div>
                        <div className="score-breakdown-bar-track">
                          <div className="score-breakdown-bar-fill" style={{ width: `${((b.max - b.score) / b.max) * 100}%`, background: barColor }} />
                        </div>
                        <p className="score-breakdown-detail">{b.detail}</p>
                        <p className="score-breakdown-explanation">{SCORE_EXPLANATIONS[b.label]?.[sevKey] || ''}</p>
                      </div>
                    )
                  })}
                </>
              )
            })()}
            {analysisDetail === 'noise' && (
              <>
                {analysisResults.noiseError ? (
                  <>
                    <p className="analysis-expand-level clear">Airport noise data couldn't be loaded for this location.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        This result is unknown, not a clean bill of health. Reload LandRecon and
                        re-analyze the address to retry the airport noise dataset.
                      </p>
                    </div>
                    <button type="button" className="analysis-expand-retry" onClick={() => window.location.reload()}>
                      Reload LandRecon
                    </button>
                  </>
                ) : analysisResults.noiseLevel ? (
                  <>
                    {analysisResults.noiseAirport && (
                      <p className="analysis-expand-sub">
                        {analysisResults.noiseAirport}{analysisResults.noiseAirportCode ? ` (${analysisResults.noiseAirportCode})` : ''}
                      </p>
                    )}
                    <p className="analysis-expand-level">Estimated: ~{analysisResults.noiseLevel} dB DNL</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Aircraft noise is measured in DNL (Day-Night Average Sound Level) and affects sleep quality, outdoor enjoyment, and long-term health.
                        {analysisResults.noiseLevel >= 65
                          ? ' At this level, the FAA considers the area "significantly impacted." Expect frequent and noticeable aircraft noise throughout the day.'
                          : analysisResults.noiseLevel >= 55
                          ? ' This area falls within the moderate impact zone. Noise may be noticeable during peak flight hours and could affect outdoor conversations.'
                          : ' This area is within a mapped noise contour but at a relatively low level. Occasional aircraft noise may be audible.'}
                      </p>
                    </div>
                    <div className="analysis-expand-rec">
                      <strong>Recommendation</strong>
                      <p>
                        Locations at 55 dB DNL or higher are considered significantly impacted by aircraft noise.
                        We recommend repeat visits at different times of day — including early morning,
                        evening, and weekends — to assess whether the noise level is acceptable.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level clear">This location is not within any mapped airport noise contour.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Airport noise can significantly affect quality of life, property values, and health.
                        This location is outside all mapped noise contours — a positive indicator for peaceful living.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'superfunds' && (
              <>
                {analysisResults.superfunds.length > 0 ? (
                  <>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        EPA Superfund sites are locations contaminated with hazardous waste that pose risks to human health and the environment.
                        Active sites may have ongoing contamination of soil, groundwater, or air, which can affect property values and health.
                      </p>
                    </div>
                    <ul className="analysis-expand-list">
                      {analysisResults.superfunds.map((s, i) => {
                        const npl = NPL_STATUS_INFO[s.statusCode]
                        return (
                          <li key={i}>
                            <div>
                              <strong>{s.name}</strong> — {s.distanceMi} mi
                              <span className={`analysis-status ${s.status === 'Deleted' ? 'status-cleared' : 'status-active'}`}>
                                {s.status}
                              </span>
                            </div>
                            {(s.city || s.epaId) && (
                              <dl className="analysis-superfund-meta">
                                {s.city && (
                                  <>
                                    <dt>Location</dt>
                                    <dd>{s.city}</dd>
                                  </>
                                )}
                                {s.epaId && (
                                  <>
                                    <dt>EPA ID</dt>
                                    <dd className="mono">{s.epaId}</dd>
                                  </>
                                )}
                              </dl>
                            )}
                            {npl && (
                              <p className="analysis-superfund-npl-desc">{npl.desc}</p>
                            )}
                            {s.url && (
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="analysis-epa-link">
                                EPA Site Profile →
                              </a>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                    <div className="analysis-expand-rec">
                      <strong>Recommendation</strong>
                      <p>
                        Research these sites using the EPA links above to understand the contamination history,
                        current cleanup status, and any health advisories.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level clear">No EPA Superfund sites found within {SUPERFUND_ANALYSIS_RADIUS_MI} miles of this address.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Superfund sites can contaminate local soil, groundwater, and air — posing health risks and reducing property values.
                        The absence of any sites nearby is a positive indicator for this location.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'commute' && (
              <>
                {(!workAddress || workAddressEditing) ? (
                  <>
                    <p className="analysis-expand-sub">
                      {workAddress ? 'Update your work address:' : 'Enter your work address to estimate the drive from this property:'}
                    </p>
                    <div className="commute-input-row">
                      <input
                        type="text"
                        className="commute-input"
                        placeholder="e.g. 123 Main St, Missoula, MT"
                        value={workAddressDraft}
                        onChange={(e) => { setWorkAddressDraft(e.target.value); setWorkAddressInputError(null) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitWorkAddress() }}
                        disabled={workAddressSaving}
                      />
                      <button
                        type="button"
                        className="commute-save-btn"
                        onClick={submitWorkAddress}
                        disabled={workAddressSaving || !workAddressDraft.trim()}
                      >
                        {workAddressSaving ? 'Looking up…' : 'Save'}
                      </button>
                    </div>
                    {workAddressInputError && <p className="commute-input-error">{workAddressInputError}</p>}
                    {workAddress && (
                      <button
                        type="button"
                        className="commute-cancel-btn"
                        onClick={() => { setWorkAddressEditing(false); setWorkAddressDraft(''); setWorkAddressInputError(null) }}
                        disabled={workAddressSaving}
                      >Cancel</button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-sub">{workAddress.address}</p>
                    {commuteLoading ? (
                      <p className="analysis-expand-level" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="analysis-card-spinner" aria-hidden="true" style={{ margin: 0 }} />
                        Calculating commute…
                      </p>
                    ) : commuteResult ? (
                      <>
                        <p className={`analysis-expand-level ${commuteSeverity(commuteResult.liveMinutes)}`}>
                          {formatCommuteMinutes(commuteResult.liveMinutes)} right now · {commuteResult.distanceMi} miles
                        </p>
                        <p style={{ fontSize: '0.78rem', color: '#888', margin: '4px 0 12px' }}>
                          ~{formatCommuteMinutes(commuteResult.typicalMinutes)} on a typical weekday, arriving by 9am
                        </p>
                        <div className="analysis-costco-actions">
                          <a
                            className="costco-directions-link"
                            href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(address || '')}&destination=${workAddress.lat},${workAddress.lng}&travelmode=driving`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M3 11l19-9-9 19-2-8-8-2z" />
                            </svg>
                            Driving directions →
                          </a>
                        </div>
                      </>
                    ) : (
                      <p className="analysis-expand-level">Couldn't calculate a route to this address — it may be unreachable by car.</p>
                    )}
                    <div className="commute-actions">
                      <button
                        type="button"
                        className="commute-change-btn"
                        onClick={() => { setWorkAddressEditing(true); setWorkAddressDraft(workAddress.address) }}
                      >Change</button>
                      <button
                        type="button"
                        className="commute-remove-btn"
                        onClick={removeWorkAddress}
                      >Remove</button>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'costco' && (
              <>
                {analysisResults.costcoLoading ? (
                  <p className="analysis-expand-level" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="analysis-card-spinner" aria-hidden="true" style={{ margin: 0 }} />
                    Still searching for nearby Costcos…
                  </p>
                ) : analysisResults.costco ? (() => {
                  const dist = analysisResults.costco.distanceMi
                  const sev = costcoSeverity(dist)
                  return (
                    <>
                      <p className="analysis-expand-sub">{analysisResults.costco.city || 'Costco Wholesale'}</p>
                      {analysisResults.costco.address && (
                        <p style={{ fontSize: '0.78rem', color: '#888', margin: '4px 0 8px' }}>{analysisResults.costco.address}</p>
                      )}
                      <p className={`analysis-expand-level ${sev}`}>{dist} miles from this address</p>
                      <div className="analysis-costco-actions">
                        <a
                          className="costco-directions-link"
                          href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(address || '')}&destination=${analysisResults.costco.lat},${analysisResults.costco.lng}&travelmode=driving`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 11l19-9-9 19-2-8-8-2z" />
                          </svg>
                          Driving directions →
                        </a>
                      </div>
                      <div className="analysis-expand-rec">
                        {sev === 'good' && (
                          <>
                            <strong>Congratulations.</strong>
                            <p>
                              You are about to be one of those insufferably happy people who
                              casually mention they "just popped over to Costco" on a Tuesday.
                              Studies (that I made up) show that residents within 30 miles of a
                              warehouse experience 73% more joy, own 4x more rotisserie
                              chickens, and have a deeply spiritual relationship with bulk
                              paper towels. You did this. You did this right.
                            </p>
                          </>
                        )}
                        {sev === 'warning' && (
                          <>
                            <strong>Acceptable. Barely.</strong>
                            <p>
                              {dist} miles. That is a <em>commitment</em>. Not a quick errand —
                              a planned expedition with a packing list, a playlist, and a snack
                              for the road. You'll do it, sure, but every trip will end with
                              you whispering "was the gas worth it?" while you eat a
                              $1.50 hot dog in the parking lot.
                            </p>
                          </>
                        )}
                        {sev === 'danger' && (
                          <>
                            <strong>Real talk for a second.</strong>
                            <p>
                              {dist} miles. To a Costco. Do you actually want to live that
                              far away from a building full of free samples and reasonably
                              priced tires? Is this house really worth a {Math.round(dist * 2)}-mile
                              round trip every time you need a flat of paper towels?
                            </p>
                          </>
                        )}
                      </div>
                      <div className="analysis-expand-rec">
                        <strong>Distance bands</strong>
                        <p>
                          <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                          <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                          <span className="analysis-band danger">51–100 mi</span> reconsider
                        </p>
                      </div>
                    </>
                  )
                })() : analysisResults.costcoError ? (
                  <>
                    <p className="analysis-expand-level warning">
                      Costco search failed. Google Places may be busy or rate-limited.
                    </p>
                    <button
                      type="button"
                      className="analysis-expand-retry"
                      onClick={retryCostco}
                    >
                      Retry Costco search
                    </button>
                  </>
                ) : analysisResults.costcoNearestBeyond ? (
                  <>
                    <p className="analysis-expand-level warning">
                      Closest Costco is <strong>{analysisResults.costcoNearestBeyond.distanceMi} mi</strong> away
                      {analysisResults.costcoNearestBeyond.city ? ` in ${analysisResults.costcoNearestBeyond.city}` : ''} —
                      outside the {COSTCO_ANALYSIS_RADIUS_MI}-mile range.
                    </p>
                    <div className="analysis-expand-rec">
                      <strong>⚠️ Bulk shopping will be a trek</strong>
                      <p>
                        Stocking up is doable but you're committing to a serious drive. Budget the gas, the time,
                        and a sturdy cooler if you're hauling frozen goods home.
                      </p>
                    </div>
                    <div className="analysis-expand-rec">
                      <strong>Distance bands</strong>
                      <p>
                        <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                        <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                        <span className="analysis-band danger">51–100 mi</span> reconsider
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level danger">
                      No Costco found within {COSTCO_ANALYSIS_RADIUS_MI} miles.
                    </p>
                    <div className="analysis-expand-rec">
                      <strong>⚠️ Are you sure about this?</strong>
                      <p>
                        There is <em>no Costco</em> within {COSTCO_ANALYSIS_RADIUS_MI} miles.
                        You will have to survive on normal-sized packages of toilet paper.
                        Sourcing a 48-pack of muffins will require <em>logistics</em>.
                      </p>
                    </div>
                    <div className="analysis-expand-rec">
                      <strong>Distance bands</strong>
                      <p>
                        <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                        <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                        <span className="analysis-band danger">51–100 mi</span> reconsider
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'datacenters' && (
              <>
                {analysisResults.dataCenters.length > 0 ? (
                  <>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Data centers can impact surrounding areas through increased traffic,
                        noise from cooling systems, and strain on local power and water resources.
                      </p>
                    </div>
                    <ul className="analysis-expand-list">
                      {analysisResults.dataCenters.map((dc, i) => (
                        <li key={i} className="dc-analysis-item">
                          <div className="dc-analysis-header">
                            <span className="dc-status-dot" style={{ background: DC_STATUS_COLORS[dc.status] || '#6b7280' }} />
                            <strong>{dc.name || 'Unknown Facility'}</strong>
                            <span className="dc-distance">{dc.distanceMi} mi</span>
                          </div>
                          <div className="dc-analysis-meta">
                            {dc.operator && <span>{dc.operator}</span>}
                            {(dc.city || dc.state) && <span>{[dc.city, dc.state].filter(Boolean).join(', ')}</span>}
                            <span>{dc.status}</span>
                            {dc.mw && <span>{dc.mw} MW</span>}
                            {dc.sizerank && dc.sizerank !== 'Unknown' && <span>{dc.sizerank}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="analysis-expand-rec">
                      <strong>Status colors</strong>
                      <div className="analysis-dc-legend">
                        {DC_STATUSES.map((s) => (
                          <span key={s} className="analysis-dc-legend-item">
                            <span className="legend-dot" style={{ background: DC_STATUS_COLORS[s] }} />
                            {DC_STATUS_LABELS[s]}
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level clear">No data centers found within {DATA_CENTER_ANALYSIS_RADIUS_MI} miles.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Data centers can impact surrounding areas through increased traffic,
                        noise from cooling systems, and strain on local power and water resources.
                        The absence of any nearby is a positive indicator for this location.
                      </p>
                    </div>
                    <div className="analysis-expand-rec">
                      <strong>Status colors</strong>
                      <div className="analysis-dc-legend">
                        {DC_STATUSES.map((s) => (
                          <span key={s} className="analysis-dc-legend-item">
                            <span className="legend-dot" style={{ background: DC_STATUS_COLORS[s] }} />
                            {DC_STATUS_LABELS[s]}
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'crowd' && (
              <>
                {analysisResults.crowdMagnets.length > 0 ? (
                  <>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Stadiums, concert venues, parks, theme parks, and racetracks can
                        generate significant crowd noise and event-day traffic surges nearby.
                      </p>
                    </div>
                    <ul className="analysis-expand-list">
                      {analysisResults.crowdMagnets.map((m) => (
                        <li key={m.id} className="dc-analysis-item">
                          <div className="dc-analysis-header">
                            <span className="dc-status-dot" style={{ background: CROWD_COLORS[m.type] }} />
                            <strong>{CROWD_ICONS[m.type]} {m.name}</strong>
                            <span className="dc-distance">{m.distanceMi} mi</span>
                          </div>
                          <div className="dc-analysis-meta">
                            <span>{CROWD_LABEL_SINGULAR[m.type]}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : analysisResults.crowdError ? (
                  <>
                    <p className="analysis-expand-level clear">Crowd data unavailable.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        The crowd-magnet data source (OpenStreetMap Overpass) was busy or
                        unreachable, so we couldn&apos;t confirm whether any large venues are
                        nearby. This is not a clean &ldquo;none nearby&rdquo; result — re-run
                        the analysis in a moment to check again.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level clear">No crowd magnets found within {CROWD_ANALYSIS_RADIUS_MI} miles.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Stadiums, concert venues, parks, theme parks, and racetracks can
                        generate significant crowd noise and event-day traffic surges nearby.
                        The absence of any nearby is a positive indicator for this location.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'railroad' && (() => {
              const rr = analysisResults.nearestRailroad
              return (
                <>
                  {rr ? (
                    <>
                      <p className="analysis-expand-level warning">Active railroad track ~{rr.distanceMi} mi away</p>
                      <div className="analysis-expand-rec">
                        <strong>Why this matters</strong>
                        <p>
                          A railroad track within a quarter mile can bring train-horn noise
                          (federal rules require sounding the horn at public crossings),
                          ground vibration, and overnight freight movements. How disruptive
                          this is depends heavily on how often trains run and at what hours.
                        </p>
                        <p>
                          <strong>Recommendation:</strong> visit the property multiple times —
                          including evenings and overnight — to hear the trains firsthand and
                          make sure the noise isn&apos;t a dealbreaker before committing.
                        </p>
                      </div>
                      <ul className="analysis-expand-list">
                        <li className="dc-analysis-item">
                          <div className="dc-analysis-header">
                            <span className="dc-status-dot" style={{ background: '#8d6e63' }} />
                            <strong>🚂 {rr.name}</strong>
                            <span className="dc-distance">{rr.distanceMi} mi</span>
                          </div>
                        </li>
                      </ul>
                      <p className="analysis-expand-hint">The track and the quarter-mile boundary are highlighted on the map.</p>
                    </>
                  ) : analysisResults.railroadError ? (
                    <>
                      <p className="analysis-expand-level clear">Railroad data unavailable.</p>
                      <div className="analysis-expand-rec">
                        <strong>Why this matters</strong>
                        <p>
                          The railroad data source (OpenStreetMap Overpass) was busy or
                          unreachable, so we couldn&apos;t confirm whether a track is nearby.
                          This is not a clean &ldquo;no track&rdquo; result — re-run the
                          analysis in a moment to check again.
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="analysis-expand-level clear">No railroad track within {RAILROAD_ANALYSIS_RADIUS_MI} miles.</p>
                      <div className="analysis-expand-rec">
                        <strong>Why this matters</strong>
                        <p>
                          Railroad tracks close to a home bring train-horn noise, vibration,
                          and overnight freight movements. No track within a quarter mile is a
                          positive indicator for this location.
                        </p>
                      </div>
                    </>
                  )}
                </>
              )
            })()}

            {analysisDetail === 'broadband' && (() => {
              const bb = analysisResults.broadband
              const summary = bb?.summary || null
              const block = bb?.block || null
              const tierLabel = (() => {
                const t = summary?.speedTier
                if (t === 'gig') return 'Gigabit available'
                if (t === 'fast') return '100+ Mbps available'
                if (t === 'served') return 'Served (25/3 Mbps minimum)'
                if (t === 'underserved') return 'Underserved (below 25/3 Mbps)'
                return ''
              })()
              const tierClass = broadbandSeverity(summary?.speedTier)
              return (
                <>
                  {summary ? (
                    <>
                      <p className={`analysis-expand-level ${tierClass}`}>{tierLabel}</p>
                      <div className="broadband-stats">
                        <div className="broadband-stat">
                          <span className="broadband-stat-label">Max download</span>
                          <strong>{formatBroadbandSpeed(summary.maxDownMbps)}</strong>
                        </div>
                        <div className="broadband-stat">
                          <span className="broadband-stat-label">Max upload</span>
                          <strong>{formatBroadbandSpeed(summary.maxUpMbps)}</strong>
                        </div>
                        <div className="broadband-stat">
                          <span className="broadband-stat-label">Providers</span>
                          <strong>{summary.providerCount}</strong>
                        </div>
                      </div>
                      {summary.technologies.length > 0 && (
                        <div className="broadband-tech-chips">
                          <span className="broadband-tech-chips-label">Available:</span>
                          {summary.technologies.map((t) => (
                            <span key={t.code} className={`broadband-tech-chip${t.code === 50 ? ' fiber' : ''}`}>
                              {t.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {summary.providers && summary.providers.length > 0 && (
                        <ul className="analysis-expand-list broadband-providers">
                          {summary.providers.slice(0, 12).map((p, i) => (
                            <li key={`${p.name}|${p.tech}|${i}`} className="dc-analysis-item">
                              <div className="dc-analysis-header">
                                <span className="dc-status-dot" style={{ background: p.tech === 50 ? '#16a34a' : p.tech === 40 ? '#0ea5e9' : p.tech === 10 ? '#f59e0b' : p.tech === 61 ? '#6366f1' : '#9ca3af' }} />
                                <strong>{p.name}</strong>
                                <span className="dc-distance">{formatBroadbandSpeed(p.down)}</span>
                              </div>
                              <div className="dc-analysis-meta">
                                <span>{BROADBAND_TECH_LABELS[p.tech] || `Tech ${p.tech}`}</span>
                                <span> · {formatBroadbandSpeed(p.up)} up</span>
                                {p.br === 'B' && <span> · Business-only</span>}
                              </div>
                            </li>
                          ))}
                          {summary.providers.length > 12 && (
                            <li className="broadband-provider-more">+ {summary.providers.length - 12} more providers</li>
                          )}
                        </ul>
                      )}
                      <div className="analysis-expand-rec">
                        <strong>What this means</strong>
                        <p>
                          The FCC Broadband Data Collection shows the maximum <em>advertised</em>
                          speeds providers are willing to deliver to this census block. Real
                          throughput depends on plan tier, time of day, and last-mile build-out.
                          Fiber and cable are typically reliable; fixed wireless and DSL can vary
                          significantly. {summary.hasFiber ? 'Fiber availability is a strong positive — symmetric speeds, low latency, and meaningful future-proofing for streaming, remote work, and resale.' : 'Fiber is not yet built out here; expect cable, fixed wireless, or DSL as your primary options.'}
                        </p>
                      </div>
                      {bb?.asOfDate && (
                        <p style={{ fontSize: '0.7rem', color: '#888', marginTop: '10px' }}>
                          FCC BDC filing as of {bb.asOfDate} · Block {block?.blockFips}
                        </p>
                      )}
                    </>
                  ) : block ? (
                    <>
                      <p className="analysis-expand-level clear">
                        {block.county} County, {block.stateName}
                      </p>
                      <p style={{ fontSize: '0.85rem', color: '#ccc', marginTop: '12px' }}>
                        Census block <code>{block.blockFips}</code> resolved successfully, but the
                        per-block broadband index isn't built on this deployment yet.
                      </p>
                    </>
                  ) : (
                    <p className="analysis-expand-level clear">
                      Broadband lookup unavailable for this location.
                    </p>
                  )}
                </>
              )
            })()}

            {analysisDetail === 'er' && (
              <>
                {analysisResults.nearestER ? (() => {
                  const dist = analysisResults.nearestER.distanceMi
                  const sev = erSeverity(dist)
                  return (
                    <>
                      <p className="analysis-expand-sub">{analysisResults.nearestER.name}</p>
                      {analysisResults.nearestER.address && (
                        <p style={{ fontSize: '0.78rem', color: '#888', margin: '4px 0 8px' }}>{analysisResults.nearestER.address}</p>
                      )}
                      <p className={`analysis-expand-level ${sev}`}>{dist} miles from this address</p>
                      <div className="analysis-costco-actions">
                        <a
                          className="costco-directions-link"
                          href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(address || '')}&destination=${analysisResults.nearestER.lat},${analysisResults.nearestER.lng}&travelmode=driving`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 11l19-9-9 19-2-8-8-2z" />
                          </svg>
                          Driving directions →
                        </a>
                      </div>
                      <div className="analysis-expand-rec">
                        <strong>Why this matters</strong>
                        <p>
                          Proximity to an emergency room can be critical in life-threatening situations.
                          {sev === 'clear' || sev === 'good'
                            ? ' This location has good access to emergency medical care.'
                            : sev === 'warning'
                            ? ' At this distance, travel time to the ER may be a factor during emergencies.'
                            : ' The nearest ER is far away — consider this carefully if quick emergency access is important to you.'}
                        </p>
                      </div>
                      <div className="analysis-expand-rec">
                        <strong>Distance bands</strong>
                        <p>
                          <span className="analysis-band good">≤ 10 mi</span> good · {' '}
                          <span className="analysis-band warning">11–15 mi</span> caution · {' '}
                          <span className="analysis-band danger">&gt; 15 mi</span> concern
                        </p>
                      </div>
                    </>
                  )
                })() : (
                  <>
                    <p className="analysis-expand-level danger">
                      No emergency rooms found within {ER_ANALYSIS_RADIUS_MI} miles.
                    </p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Proximity to an emergency room can be critical in life-threatening situations.
                        No hospitals or emergency departments were found within the search radius.
                        This could significantly impact response times in a medical emergency.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'flood' && (() => {
              const fz = analysisResults.floodZone
              const sev = analysisResults.floodError ? 'clear' : fz ? floodSeverity(fz.bucket as keyof typeof FLOOD_ZONE_COLORS) : 'clear'
              if (analysisResults.floodError) {
                return (
                  <>
                    <p className="analysis-expand-level clear">FEMA flood data couldn’t be loaded for this location.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Flood zone designation affects flood-insurance requirements, premiums, and risk.
                        Try re-analyzing, or look up the address directly on the{' '}
                        <a href="https://msc.fema.gov/portal/home" target="_blank" rel="noopener noreferrer">FEMA Flood Map Service Center</a>.
                      </p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  <p className={`analysis-expand-level ${sev}`}>
                    {fz ? `${FLOOD_ZONE_LABELS[fz.bucket]} — ${fz.label}` : 'Not within a mapped FEMA flood hazard zone'}
                  </p>
                  <div className="analysis-expand-rec">
                    <strong>Why this matters</strong>
                    <p>
                      {sev === 'danger'
                        ? 'This address sits in a Special Flood Hazard Area (1% annual-chance / “100-year” floodplain). Federally backed mortgages here require flood insurance, premiums are typically higher, and the structure faces meaningful flood risk.'
                        : sev === 'warning'
                        ? 'This address is in a moderate-risk zone (0.2% annual-chance / “500-year” floodplain). Flood insurance is usually optional but recommended — moderate-risk areas still account for a substantial share of flood claims.'
                        : fz
                        ? 'This address is in a minimal-hazard or undetermined zone. Flood insurance is generally not federally required, though no area is completely risk-free.'
                        : 'This address is outside FEMA’s mapped flood hazard zones, so flood insurance is generally not federally required. Mapping is periodic, so it can lag local changes.'}
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Risk bands</strong>
                    <p>
                      <span className="analysis-band danger">A/AE/V</span> high · {' '}
                      <span className="analysis-band warning">0.2% shaded X</span> moderate · {' '}
                      <span className="analysis-band good">unshaded X / D</span> minimal
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Source</strong>
                    <p>
                      FEMA National Flood Hazard Layer via the{' '}
                      <a href="https://msc.fema.gov/portal/home" target="_blank" rel="noopener noreferrer">Flood Map Service Center</a>. Flag shown only for moderate risk or higher.
                    </p>
                  </div>
                </>
              )
            })()}

            {analysisDetail === 'wildfire' && (() => {
              const wf = analysisResults.wildfireHazard
              const sev = analysisResults.wildfireError ? 'clear' : wf ? wildfireSeverity(wf.value) : 'clear'
              if (analysisResults.wildfireError) {
                return (
                  <>
                    <p className="analysis-expand-level clear">USFS wildfire hazard data couldn’t be loaded for this location.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Wildfire hazard affects insurance availability and premiums, defensible-space
                        requirements, and personal safety. Try re-analyzing, or explore the{' '}
                        <a href="https://wildfirerisk.org/" target="_blank" rel="noopener noreferrer">Wildfire Risk to Communities</a> tool.
                      </p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  <p className={`analysis-expand-level ${sev}`}>
                    {wf ? `${wf.label} wildfire hazard` : 'No mapped USFS wildfire hazard'}
                  </p>
                  <div className="analysis-expand-rec">
                    <strong>Why this matters</strong>
                    <p>
                      {sev === 'danger'
                        ? 'This address falls in a High or Very High wildfire hazard class. Expect stricter insurance underwriting and higher premiums, defensible-space and home-hardening obligations, and meaningful wildfire risk during fire season.'
                        : wf && wf.value === 3
                        ? 'This address is in a Moderate wildfire hazard class — not flagged in the report, but risk is real. Defensible space and ember-resistant home hardening are still worthwhile precautions.'
                        : wf
                        ? 'This address is in a Low / Very Low class, or a non-burnable (developed) or water area. Wildfire risk here is minimal, though no area is entirely risk-free.'
                        : 'This address has no mapped USFS wildfire hazard class (e.g. outside the contiguous U.S. coverage). That is not a guarantee of zero risk.'}
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Hazard classes</strong>
                    <p>
                      <span className="analysis-band danger">High / Very high</span> flagged · {' '}
                      <span className="analysis-band good">Moderate</span> noted, not flagged · {' '}
                      <span className="analysis-band good">Low / Very low</span> minimal
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Source</strong>
                    <p>
                      USFS Wildfire Hazard Potential (classified, 2023) via the{' '}
                      <a href="https://www.firelab.org/project/wildfire-hazard-potential" target="_blank" rel="noopener noreferrer">USFS Fire Modeling Institute</a>. Auto-revealed on the map only for High risk or higher.
                    </p>
                  </div>
                </>
              )
            })()}

            {analysisDetail === 'seismic' && (() => {
              const sq = analysisResults.seismicHazard
              const sev = analysisResults.seismicError ? 'clear' : sq ? seismicSeverity(sq.value) : 'clear'
              if (analysisResults.seismicError) {
                return (
                  <>
                    <p className="analysis-expand-level clear">USGS seismic design data couldn’t be loaded for this location (coverage is limited to the U.S.).</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Seismic hazard affects building codes, retrofit requirements, and earthquake
                        insurance costs. Try re-analyzing, or explore the{' '}
                        <a href="https://earthquake.usgs.gov/hazards/" target="_blank" rel="noopener noreferrer">USGS Earthquake Hazards</a> program.
                      </p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  <p className={`analysis-expand-level ${sev}`}>
                    {sq ? `${sq.label} seismic hazard${typeof sq.pga === 'number' ? ` · PGA ${sq.pga} g` : ''}` : 'No mapped seismic hazard'}
                  </p>
                  <div className="analysis-expand-rec">
                    <strong>Why this matters</strong>
                    <p>
                      {sev === 'danger'
                        ? 'This address falls in a High or Very High seismic hazard band. Expect stricter seismic building codes, potential retrofit obligations on older structures, and higher earthquake-insurance premiums.'
                        : sq && sq.value === 3
                        ? 'This address is in a Moderate seismic hazard band — not flagged in the report, but real shaking risk exists. Seismic-aware construction and earthquake insurance are still worth considering.'
                        : sq
                        ? 'This address is in a Low / Very Low seismic hazard band. Earthquake risk here is minimal, though no area is entirely risk-free.'
                        : 'This address has no mapped seismic design value (e.g. outside U.S. coverage). That is not a guarantee of zero risk.'}
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Hazard bands (design PGA, g)</strong>
                    <p>
                      <span className="analysis-band danger">High / Very high (≥0.30)</span> flagged · {' '}
                      <span className="analysis-band good">Moderate (0.15–0.30)</span> noted, not flagged · {' '}
                      <span className="analysis-band good">Low / Very low (&lt;0.15)</span> minimal
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Source</strong>
                    <p>
                      USGS Design Maps (ASCE 7-16, Risk Category II, Site Class D) — design peak
                      ground acceleration via the{' '}
                      <a href="https://earthquake.usgs.gov/ws/designmaps/" target="_blank" rel="noopener noreferrer">USGS Seismic Design web service</a>. No dedicated map overlay (point hazard only).
                    </p>
                  </div>
                </>
              )
            })()}
            {analysisDetail === 'tornado' && (() => {
              const tn = analysisResults.tornadoHazard
              const sev = analysisResults.tornadoError ? 'clear' : tn ? tornadoSeverity(tn.value) : 'clear'
              if (analysisResults.tornadoError) {
                return (
                  <>
                    <p className="analysis-expand-level clear">FEMA National Risk Index tornado data couldn’t be loaded for this location (coverage is limited to the U.S.).</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Tornado risk affects insurance costs, building resilience, and the value of
                        storm shelters or safe rooms. Try re-analyzing, or explore the{' '}
                        <a href="https://hazards.fema.gov/nri/tornado" target="_blank" rel="noopener noreferrer">FEMA NRI Tornado</a> data.
                      </p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  <p className={`analysis-expand-level ${sev}`}>
                    {tn ? `${tn.rating} tornado risk${typeof tn.score === 'number' ? ` · NRI score ${tn.score.toFixed(1)}` : ''}` : 'No mapped tornado risk'}
                  </p>
                  <div className="analysis-expand-rec">
                    <strong>Why this matters</strong>
                    <p>
                      {sev === 'danger'
                        ? 'This census tract carries a Relatively High or Very High tornado risk rating. Expect higher wind/storm insurance premiums, and consider a safe room or storm shelter and wind-rated construction.'
                        : tn && tn.value === 3
                        ? 'This tract is in a Relatively Moderate tornado risk band — not flagged in the report, but meaningful storm risk exists. A storm plan and adequate coverage are still worth considering.'
                        : tn
                        ? 'This tract is in a Relatively Low / Very Low tornado risk band. Tornado risk here is minimal, though no area is entirely risk-free.'
                        : 'This address has no mapped tornado risk rating (e.g. outside U.S. coverage). That is not a guarantee of zero risk.'}
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Risk ratings</strong>
                    <p>
                      <span className="analysis-band danger">Relatively / Very High</span> flagged · {' '}
                      <span className="analysis-band good">Relatively Moderate</span> noted, not flagged · {' '}
                      <span className="analysis-band good">Relatively / Very Low</span> minimal
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Source</strong>
                    <p>
                      FEMA National Risk Index — composite tornado risk rating by census tract,
                      via the{' '}
                      <a href="https://hazards.fema.gov/nri/" target="_blank" rel="noopener noreferrer">FEMA National Risk Index</a>. Toggle the Tornado Risk overlay to see nearby tracts.
                    </p>
                  </div>
                </>
              )
            })()}
          </div>
        </aside>
      )}
    </>
  )
}
