const router = require('express').Router();
const { query, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { send, history } = require('../controllers/paymentController');
const paymentSendValidators = require('../validators/paymentSendValidators');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(authMiddleware);

router.post('/send', paymentSendValidators, validate, idempotency, send);

router.get(
  '/history',
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('limit must be between 1 and 100'),
  ],
  validate,
  history
);

module.exports = router;
