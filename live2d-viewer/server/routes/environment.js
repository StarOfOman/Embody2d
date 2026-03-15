import { Router } from 'express'
import { sendToAvatar, broadcast } from '../index.js'
const router = Router()

router.post('/:id/background', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'env-background', ...req.body }) }))

router.post('/:id/overlay', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'env-overlay', ...req.body }) }))

router.post('/:id/reset', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'env-reset' }) }))

router.post('/broadcast/background', (req, res) =>
  res.json({ sent: broadcast({ type: 'env-background', ...req.body }) }))

export default router
