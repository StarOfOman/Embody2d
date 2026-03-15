import { Router } from 'express'
import { sendToAvatar } from '../index.js'
const router = Router()

router.post('/:id/scale', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'avatar-scale', value: req.body.value }) }))

router.post('/:id/position', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'avatar-position', ...req.body }) }))

router.post('/:id/tint', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'avatar-tint', hex: req.body.hex }) }))

router.post('/:id/alpha', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'avatar-alpha', value: req.body.value }) }))

export default router
