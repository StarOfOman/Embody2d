import { Router } from 'express'
import { sendToAvatar } from '../index.js'
const router = Router()

router.post('/:id/expression', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'expression', value: req.body.expression }) }))

router.post('/:id/motion', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'motion', ...req.body }) }))

router.post('/:id/parameter', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'parameter', ...req.body }) }))

router.post('/:id/lipsync', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'lipsync', ...req.body }) }))

router.post('/:id/load-model', (req, res) =>
  res.json({ success: sendToAvatar(req.params.id, { type: 'load-model', ...req.body }) }))

export default router
