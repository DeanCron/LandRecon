export const NPL_STATUS_INFO: Record<string, { label: string; desc: string }> = {
  F: { label: 'Final', desc: 'Officially listed on the NPL as a priority cleanup site' },
  P: { label: 'Proposed', desc: 'Proposed for NPL listing; under public comment review' },
  D: { label: 'Deleted', desc: 'Removed from NPL after cleanup goals were met' },
  R: { label: 'Removed', desc: 'Removed from proposed NPL listing' },
  W: { label: 'Withdrawn', desc: 'Proposed for NPL but later withdrawn before listing' },
  N: { label: 'Not on NPL', desc: 'Evaluated but not currently on the National Priorities List' },
  I: { label: 'Tribal Land', desc: 'Site located on or affecting tribal lands' },
}
