module.exports = async function handler(req, res) {
  const { folder } = req.query;

  if (!folder) {
    return res.status(400).json({ error: 'Folder required' });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return res.status(500).json({ error: 'Missing Cloudinary credentials' });
  }

  const credentials = Buffer.from(apiKey + ':' + apiSecret).toString('base64');

  try {
    const response = await fetch(
      'https://api.cloudinary.com/v1_1/' + cloudName + '/resources/image?prefix=' + encodeURIComponent(folder) + '&max_results=50&type=upload',
      {
        headers: {
          'Authorization': 'Basic ' + credentials
        }
      }
    );

    const data = await response.json();

    if (!data.resources || data.resources.length === 0) {
      return res.status(404).json({ 
        error: 'No photos found',
        searched: folder,
        cloudName: cloudName
      });
    }

    const photos = data.resources.map(function(resource) {
      return {
        url: 'https://res.cloudinary.com/' + cloudName + '/image/upload/w_800,q_70/' + resource.public_id + '.' + resource.format,
        fullUrl: 'https://res.cloudinary.com/' + cloudName + '/image/upload/' + resource.public_id + '.' + resource.format,
        publicId: resource.public_id
      };
    });

    res.status(200).json({ photos: photos });

  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch photos', details: err.message });
  }
}
