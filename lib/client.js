// Browser half: one button in the composer dock that updates the plugin market.
// Format follows DSH's lazy-CJS client module contract: a factory registered on
// window.__ModuleLoader__, id equal to the package name, React from the table.
window.__ModuleLoader__.load({
  id: 'dsh-update-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const buttonStyle = {
      fontSize: 12,
      lineHeight: '20px',
      padding: '2px 10px',
      borderRadius: 6,
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      opacity: 0.85,
    }
    const messageStyle = { fontSize: 12, opacity: 0.7 }

    function MarketUpdateButton() {
      const [state, setState] = React.useState('idle')
      const [message, setMessage] = React.useState('')

      const onClick = React.useCallback(async () => {
        setState('busy')
        setMessage('')
        try {
          const response = await fetch('/dsh-update-assistant/market-update', {
            method: 'POST',
            headers: { 'x-dsh-update-client': '1' },
            credentials: 'same-origin',
          })
          const data = await response.json().catch(() => ({}))
          setState(data.ok ? 'done' : 'error')
          setMessage(data.message ?? data.error ?? (data.ok ? '完成' : '更新失败'))
        } catch (error) {
          setState('error')
          setMessage(String(error?.message ?? error))
        }
      }, [])

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' } },
        h(
          'button',
          {
            type: 'button',
            onClick,
            disabled: state === 'busy',
            style: { ...buttonStyle, opacity: state === 'busy' ? 0.5 : 0.85, cursor: state === 'busy' ? 'default' : 'pointer' },
          },
          state === 'busy' ? '更新插件市场…' : '更新插件市场',
        ),
        message === '' ? null : h('span', { style: messageStyle }, message),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-update-assistant', order: 95 },
            MarketUpdateButton,
          ),
        )
      },
    }
  },
})
