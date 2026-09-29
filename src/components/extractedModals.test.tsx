import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ShareModal } from './ShareModal'
import { DevTodosModal } from './DevTodosModal'

describe('ShareModal', () => {
  const base = {
    shareUrl: 'https://landrecon.com/s/abc',
    shareLongUrl: 'https://landrecon.com/map?address=x',
    loading: false,
    error: null,
    onError: vi.fn(),
    isGps: false,
    address: '1 Main St',
    onClose: vi.fn(),
  }

  it('copies the short link and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ShareModal {...base} />)
    fireEvent.click(screen.getByText('Copy link'))
    expect(await screen.findByText('✓ Copied!')).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(base.shareUrl)
  })

  it('reports a clipboard failure through onError', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    const onError = vi.fn()
    render(<ShareModal {...base} onError={onError} />)
    fireEvent.click(screen.getByText('Copy link'))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Clipboard access denied — please copy manually.'))
  })

  it('warns that GPS links reveal the location', () => {
    render(<ShareModal {...base} isGps />)
    expect(screen.getByText(/reveals the analyzed GPS location/)).toBeTruthy()
  })
})

describe('DevTodosModal', () => {
  it('adds trimmed text and clears the local input', () => {
    const onAdd = vi.fn()
    render(
      <DevTodosModal
        items={[{ id: 'a', label: 'First' }]}
        checks={{}}
        sync="idle"
        remaining={1}
        onToggle={vi.fn()}
        onAdd={onAdd}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('New todo text') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  Ship it ' } })
    fireEvent.click(screen.getByText('Add'))
    expect(onAdd).toHaveBeenCalledWith('  Ship it ')
    expect(input.value).toBe('')
    expect(screen.getByText('1 of 1 remaining')).toBeTruthy()
  })
})
