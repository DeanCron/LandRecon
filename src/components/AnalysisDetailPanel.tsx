import type { Dispatch, SetStateAction } from 'react'
import type { CommuteEstimate, WorkAddress } from '../map/commute'
import type { AnalysisDetail, AnalysisResults } from '../map/analysisTypes'
import ReportView from './ReportView'

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
            <ReportView
              analysisDetail={analysisDetail}
              analysisResults={analysisResults}
              address={address}
              workAddress={workAddress}
              workAddressEditing={workAddressEditing}
              workAddressDraft={workAddressDraft}
              workAddressSaving={workAddressSaving}
              workAddressInputError={workAddressInputError}
              commuteLoading={commuteLoading}
              commuteResult={commuteResult}
              setWorkAddressDraft={setWorkAddressDraft}
              setWorkAddressInputError={setWorkAddressInputError}
              setWorkAddressEditing={setWorkAddressEditing}
              submitWorkAddress={submitWorkAddress}
              removeWorkAddress={removeWorkAddress}
              retryCostco={retryCostco}
            />
          </div>
        </aside>
      )}
    </>
  )
}
