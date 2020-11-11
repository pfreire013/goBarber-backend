import Appointment from '../models/Appointment'
import * as Yup from 'yup'
import pt from 'date-fns/locale/pt'
import User from '../models/User'
import File from '../models/FIle'
import { startOfHour, parseISO, isBefore, format, subHours } from 'date-fns'
import Notification from '../schemas/Notification'

import CancellationMail from '../jobs/CancellationMail'
import Queue from '../../lib/Queue'

class AppointmentController {
  async index(req, res) {
    const { page = 1 } = req.query
    const appointment = await Appointment.findAll({
      where: {
        user_id: req.userId,
        canceled_at: null,
      },
      attributes: ['id', 'date', 'past', 'cancelable'],
      order: ['date'],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url']
            }
          ]
        }
      ]
    })

    return res.json(appointment)
  }

  async store (req, res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    })

    if(!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: 'Validation fails'})
    }

    const { provider_id, date } = req.body

    /**
     * Check if provider_id is a provider
     */
    const checkIsProvider = await User.findOne({
      where: { id: provider_id, provider: true }
    })

    if(!checkIsProvider) {
      return res
        .status(401)
        .json({
          error: 'You can only create appointments with providers'
        })
    }

     /**
     * Check if provider_id is same user_id
     */
    if(provider_id === req.userId) {
      return res
        .status(401)
        .json({
          error: 'Provider can not create appointment with yourself'
        })
    }

     /**
     * Check for past dates
     */

    const hourStart = startOfHour(parseISO(date))

    if(isBefore(hourStart, new Date())) {
      return res.status(400).json({ error: 'Past dates are no permitted'})
    }

     /**
     * Check date availability
     */
    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date: hourStart
      }
    })

    if (checkAvailability) {
      return res.status(400).json({ error: 'Appointment date is not available'})
    }

    const appointment = await Appointment.create({
       user_id: req.userId,
       provider_id,
       date: hourStart
     })

     /**
      * Notify appointment provider
      */
     const user = await User.findByPk(req.userId)
     const formattedDate = format(
       hourStart,
       "'dia' dd 'de' MMMM', às' H:mm'h'",
       { locale: pt }
     )

     await Notification.create({
       content: `Novo agendamento de ${user.name} para ${formattedDate}`,
       user: provider_id
     })

    return res.json(appointment)
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email']
        },
        {
          model: User,
          as: 'user',
          attributes: ['name']
        }
      ]
    })

    if(appointment.user_id !== req.userId) {
      return res.status(401).json({
        error: "You don't have permission to cancel this appointment."
      })
    }

    const dateWithSub = subHours(appointment.date, 2)

    if (isBefore(dateWithSub, new Date())) {
      return res.status(401).json({
        error: 'You can only cancel appointment 2 hours in advance'
      })
    }

    appointment.canceled_at = new Date()

    await appointment.save()

    await Queue.add(CancellationMail.key, {
      appointment
    })

    return res.json(appointment)
  }
}

export default new AppointmentController()