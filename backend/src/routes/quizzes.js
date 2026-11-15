
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const authMiddleware = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },
});

const handleUpload = (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    next();
  });
};

const getServiceUrl = () =>
  (process.env.QUIZ_SERVICE_URL || 'http://localhost:8002').replace(/\/$/, '');

const getServiceHeaders = (headers = {}) => {
  const serviceHeaders = { ...headers };
  if (process.env.QUIZ_SERVICE_API_KEY) {
    serviceHeaders['X-API-Key'] = process.env.QUIZ_SERVICE_API_KEY;
  }
  return serviceHeaders;
};

const getUpstreamErrorMessage = (error) => {
  let data = error.response?.data;
  if (Buffer.isBuffer(data)) {
    try {
      data = JSON.parse(data.toString('utf8'));
    } catch {
      data = null;
    }
  }

  return (
    data?.detail ||
    data?.error ||
    (error.response ? 'Quiz service request failed.' : 'Unable to connect to the Python quiz service.')
  );
};

router.post(
  '/generate',
  authMiddleware,
  handleUpload,
  async (req, res) => {
    try {
      const files = req.files || [];

      if (files.length === 0) {
        return res.status(400).json({
          error: 'Please upload at least one file.',
        });
      }

      const rawIds = req.body.material_ids;
      const materialIds = Array.isArray(rawIds)
        ? rawIds
        : rawIds
          ? [rawIds]
          : [];

      if (materialIds.length !== files.length) {
        return res.status(400).json({
          error: 'Each uploaded file must have a material ID.',
        });
      }

      const numQuestions = Number(req.body.num_questions || 10);
      const difficulty = req.body.difficulty || 'medium';

      if (!Number.isInteger(numQuestions) || numQuestions < 1 || numQuestions > 50) {
        return res.status(400).json({
          error: 'Number of questions must be between 1 and 50.',
        });
      }

      if (!['easy', 'medium', 'hard', 'mixed'].includes(difficulty)) {
        return res.status(400).json({
          error: 'Invalid difficulty level.',
        });
      }

      const form = new FormData();

      files.forEach((file, index) => {
        form.append('files', file.buffer, {
          filename: file.originalname,
          contentType: file.mimetype,
        });

        form.append('material_ids', materialIds[index]);
      });

      form.append('num_questions', String(numQuestions));
      form.append('difficulty', difficulty);

      const response = await axios.post(
        `${getServiceUrl()}/generate-quiz`,
        form,
        {
          headers: getServiceHeaders(form.getHeaders()),
          maxBodyLength: Infinity,
          timeout: 180000,
        }
      );

      return res.json(response.data);

    } catch (error) {
      console.error(
        'Quiz generation error:',
        error.response?.data || error.message
      );

      return res.status(error.response?.status || 502).json({
        error: getUpstreamErrorMessage(error),
      });
    }
  }
);

router.post('/export-report', authMiddleware, async (req, res) => {
  const { quiz_title: quizTitle, class_name: className, results } = req.body || {};
  if (
    typeof quizTitle !== 'string' ||
    !quizTitle.trim() ||
    typeof className !== 'string' ||
    !className.trim() ||
    !Array.isArray(results)
  ) {
    return res.status(400).json({
      error: 'Quiz title, class name, and a results array are required.',
    });
  }

  try {
    const response = await axios.post(
      `${getServiceUrl()}/export-report`,
      req.body,
      {
        headers: getServiceHeaders({ 'Content-Type': 'application/json' }),
        responseType: 'arraybuffer',
        timeout: 120000,
      }
    );

    res.set('Content-Type', response.headers['content-type'] || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="quiz_report.xlsx"');
    return res.send(response.data);
  } catch (error) {
    console.error('Quiz report export error:', error.response?.data || error.message);
    return res.status(error.response?.status || 502).json({
      error: getUpstreamErrorMessage(error),
    });
  }
});

module.exports = router;
